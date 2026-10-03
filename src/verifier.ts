import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { LIMITS } from "./config.js";
import { filesOverlapping, pieceByteRange, type TorrentFile, type TorrentMeta } from "./torrent.js";

export type PieceStatus = "OK" | "FILE_MISSING" | "LENGTH_MISMATCH" | "CONTENT_MISMATCH";
export type FileStatus = "OK" | "MISSING" | "LENGTH_MISMATCH";

export interface PieceResult {
  index: number;
  start: number;
  end: number;
  expectedLength: number;
  status: PieceStatus;
  expectedSha1: string;
  actualSha1: string | null;
  files: string[];
}

export interface FileResult {
  relPath: string;
  expectedLength: number;
  actualLength: number | null;
  exists: boolean;
  status: FileStatus;
}

export interface VerifyReport {
  infoHash: string;
  name: string;
  mode: "single" | "multi";
  pieceLength: number;
  totalLength: number;
  pieceCount: number;
  okCount: number;
  failedCount: number;
  overallStatus: "PASS" | "FAIL";
  checkedAt: string;
  files: FileResult[];
  pieces: PieceResult[];
}

interface FileState {
  file: TorrentFile;
  exists: boolean;
  actualLength: number | null;
  status: FileStatus;
}

const READ_CHUNK = 256 * 1024;

function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

async function statFiles(files: TorrentFile[]): Promise<FileState[]> {
  return await Promise.all(
    files.map(async (file): Promise<FileState> => {
      try {
        const st = await stat(file.absPath);
        if (!st.isFile()) {
          return { file, exists: false, actualLength: null, status: "MISSING" };
        }
        const status: FileStatus = st.size === file.length ? "OK" : "LENGTH_MISMATCH";
        return { file, exists: true, actualLength: st.size, status };
      } catch {
        return { file, exists: false, actualLength: null, status: "MISSING" };
      }
    }),
  );
}

/**
 * 读取某分片窗口内、按文件顺序拼接的实际字节。
 * 文件缺失或短时，只返回可读部分（哈希自然不同；错误分类由调用方决定）。
 */
async function readPieceBytes(
  states: FileState[],
  winStart: number,
  winEnd: number,
  handles: Map<string, FileHandle>,
  batchBudget: { bytes: number },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const st of states) {
    const { file } = st;
    const fStart = file.offset;
    const fEnd = file.offset + file.length;
    const lo = Math.max(winStart, fStart);
    const hi = Math.min(winEnd, fEnd);
    if (lo >= hi) continue;
    const localFrom = lo - fStart;
    const localTo = hi - fStart;
    if (!st.exists) continue;
    let handle = handles.get(file.absPath);
    if (!handle) {
      handle = await open(file.absPath, "r");
      handles.set(file.absPath, handle);
    }
    let pos = localFrom;
    while (pos < localTo) {
      const want = Math.min(READ_CHUNK, localTo - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      pos += bytesRead;
      batchBudget.bytes += bytesRead;
      if (batchBudget.bytes >= LIMITS.MAX_PIECE_BATCH_BYTES) {
        batchBudget.bytes = 0;
        await yieldToEventLoop();
      }
    }
  }
  return Buffer.concat(chunks);
}

/** 按元信息文件顺序将内容视为连续字节流，逐片计算 SHA-1 并核对。 */
export async function verifyTorrent(meta: TorrentMeta): Promise<VerifyReport> {
  const states = await statFiles(meta.files);
  const stateByPath = new Map(states.map((s) => [s.file.relPath, s]));

  const handles = new Map<string, FileHandle>();
  const pieces: PieceResult[] = [];
  const batchBudget = { bytes: 0 };

  try {
    for (let index = 0; index < meta.expectedPieceCount; index += 1) {
      const [start, end] = pieceByteRange(meta, index);
      const overlaps = filesOverlapping(meta, start, end);
      const relPaths = overlaps.map((f) => f.relPath);
      const expectedSha1 = meta.pieceHashes[index]!.toString("hex");

      const missing = overlaps.filter((f) => stateByPath.get(f.relPath)!.status === "MISSING");
      const wrongLen = overlaps.filter((f) => stateByPath.get(f.relPath)!.status === "LENGTH_MISMATCH");

      let status: PieceStatus;
      let actualSha1: string | null = null;

      if (missing.length > 0) {
        // 缺文件：明确判失败，绝不把剩余分片当作通过
        status = "FILE_MISSING";
      } else {
        const data = await readPieceBytes(states, start, end, handles, batchBudget);
        actualSha1 = createHash("sha1").update(data).digest("hex");
        if (wrongLen.length > 0) {
          status = "LENGTH_MISMATCH";
        } else if (data.length !== end - start || actualSha1 !== expectedSha1) {
          status = "CONTENT_MISMATCH";
        } else {
          status = "OK";
        }
      }

      pieces.push({
        index,
        start,
        end,
        expectedLength: end - start,
        status,
        expectedSha1,
        actualSha1,
        files: relPaths,
      });
    }
  } finally {
    for (const h of handles.values()) await h.close().catch(() => {});
  }

  const fileResults: FileResult[] = states.map((s) => ({
    relPath: s.file.relPath,
    expectedLength: s.file.length,
    actualLength: s.actualLength,
    exists: s.exists,
    status: s.status,
  }));

  const okCount = pieces.filter((p) => p.status === "OK").length;
  const failedCount = pieces.length - okCount;

  return {
    infoHash: meta.infoHash,
    name: meta.name,
    mode: meta.mode,
    pieceLength: meta.pieceLength,
    totalLength: meta.totalLength,
    pieceCount: pieces.length,
    okCount,
    failedCount,
    overallStatus: failedCount === 0 ? "PASS" : "FAIL",
    checkedAt: new Date().toISOString(),
    files: fileResults,
    pieces,
  };
}

/** 只返回失败分片（含涉及的文件清单）。 */
export function failedPieces(report: VerifyReport): PieceResult[] {
  return report.pieces.filter((p) => p.status !== "OK");
}
