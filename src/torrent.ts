import { createHash } from "node:crypto";
import { decodeTopWithInfoSpan, type BencValue } from "./bencode.js";
import { LIMITS } from "./config.js";
import { AppError } from "./errors.js";
import { safeJoin } from "./safe-path.js";

export interface TorrentFile {
  /** 种子内相对路径片段（多文件）；单文件为 [name] */
  pathParts: string[];
  /** 相对路径（posix 风格） */
  relPath: string;
  length: number;
  /** 该文件在连续字节流中的起始偏移 */
  offset: number;
  /** 解析后得到的磁盘绝对路径（位于样例根内） */
  absPath: string;
}

export interface TorrentMeta {
  /** 从 info 原始编码字节计算的 v1 info hash（40 位十六进制） */
  infoHash: string;
  name: string;
  private_: boolean;
  pieceLength: number;
  /** 每个分片期望的 20 字节 SHA-1 */
  pieceHashes: Buffer[];
  totalLength: number;
  expectedPieceCount: number;
  files: TorrentFile[];
  mode: "single" | "multi";
  rawInfo: Buffer;
}

function asDict(v: BencValue | undefined, ctx: string): Record<string, BencValue> {
  if (!v || Buffer.isBuffer(v) || typeof v === "number" || Array.isArray(v)) {
    throw new AppError("METADATA_CORRUPT", `${ctx} 不是字典`);
  }
  return v;
}

function asInt(v: BencValue | undefined, ctx: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new AppError("METADATA_CORRUPT", `${ctx} 不是合法整数`);
  }
  return v;
}

function asBuf(v: BencValue | undefined, ctx: string): Buffer {
  if (!Buffer.isBuffer(v)) throw new AppError("METADATA_CORRUPT", `${ctx} 不是字符串`);
  return v;
}

function decodePathList(v: BencValue | undefined): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new AppError("METADATA_CORRUPT", "文件 path 字段不是非空列表");
  }
  return v.map((seg, i) => {
    if (!Buffer.isBuffer(seg)) throw new AppError("METADATA_CORRUPT", `path[${i}] 不是字符串`);
    return seg.toString("utf8");
  });
}

/**
 * 解析并校验 .torrent 字节。
 * @param contentRoot 内容根目录：单文件按 [name] 解析、多文件按 [name/...] 解析，
 *                    所有路径都必须落在该根目录下（该根本身位于样例根内）。
 */
export function parseTorrent(buf: Buffer, contentRoot: string): TorrentMeta {
  if (buf.length > LIMITS.MAX_TORRENT_SIZE) {
    throw new AppError("TOO_LARGE", `种子文件超过 ${LIMITS.MAX_TORRENT_SIZE} 字节上限`);
  }

  let rootSpan: ReturnType<typeof decodeTopWithInfoSpan>;
  try {
    rootSpan = decodeTopWithInfoSpan(buf);
  } catch (err) {
    throw new AppError("METADATA_CORRUPT", `bencode 解析失败：${(err as Error).message}`);
  }
  const { root, infoSpan } = rootSpan;
  if (!infoSpan) throw new AppError("METADATA_CORRUPT", "缺少 info 字典");

  const top = root.value;
  if (top.info === undefined) throw new AppError("METADATA_CORRUPT", "缺少 info 字典");
  const info = asDict(top.info, "info");

  // 明确拒绝 v2 / 混合种子
  if (info.meta_version !== undefined || info.meta_libtorrent_compatibility !== undefined) {
    throw new AppError("UNSUPPORTED_FORMAT", "不支持 BitTorrent v2 或混合种子（仅 v1）");
  }
  if (Buffer.isBuffer(info.pieces) && info.pieces.length === 32) {
    // pieces 为 32 字节时极可能是 v2 piece layers 的误用
    throw new AppError("UNSUPPORTED_FORMAT", "检测到 v2 特征（pieces 长度异常），仅支持 v1");
  }
  if (info.file_tree !== undefined) {
    throw new AppError("UNSUPPORTED_FORMAT", "检测到 v2 file_tree，仅支持 v1");
  }

  const nameBuf = asBuf(info.name, "info.name");
  const name = nameBuf.toString("utf8");
  if (name.length === 0) throw new AppError("METADATA_CORRUPT", "info.name 为空");

  const pieceLength = asInt(info["piece length"], "info['piece length']");
  if (pieceLength < LIMITS.MIN_PIECE_LENGTH || pieceLength > LIMITS.MAX_PIECE_LENGTH) {
    throw new AppError("METADATA_CORRUPT", `piece length 超出允许范围：${pieceLength}`);
  }

  const pieces = asBuf(info.pieces, "info.pieces");
  if (pieces.length === 0 || pieces.length % 20 !== 0) {
    throw new AppError("METADATA_CORRUPT", `pieces 长度必须为 20 的非零倍数，实际 ${pieces.length}`);
  }
  const pieceHashes: Buffer[] = [];
  for (let i = 0; i < pieces.length; i += 20) {
    pieceHashes.push(pieces.subarray(i, i + 20));
  }

  const private_ = info.private !== undefined && asInt(info.private, "info.private") === 1;

  // 构造文件清单
  let files: TorrentFile[] = [];
  let mode: "single" | "multi";
  let offset = 0;

  if (info.files !== undefined) {
    mode = "multi";
    if (info.length !== undefined) {
      throw new AppError("METADATA_CORRUPT", "info 同时包含 files 与 length（二选一）");
    }
    if (!Array.isArray(info.files)) throw new AppError("METADATA_CORRUPT", "info.files 不是列表");
    const seen = new Set<string>();
    info.files.forEach((raw, idx) => {
      const fd = asDict(raw, `files[${idx}]`);
      const length = asInt(fd.length, `files[${idx}].length`);
      if (length < 0) throw new AppError("METADATA_CORRUPT", `files[${idx}].length 为负`);
      const pathParts = decodePathList(fd.path);
      const relPath = pathParts.map((p) => p.replace(/\\/g, "/")).join("/");
      if (seen.has(relPath)) throw new AppError("METADATA_CORRUPT", `文件路径重复：${relPath}`);
      seen.add(relPath);
      const absPath = safeJoin(contentRoot, pathParts);
      files.push({ pathParts, relPath: pathParts.map((p) => p.replace(/\\/g, "/")).join("/"), length, offset, absPath });
      offset += length;
    });
  } else {
    mode = "single";
    const length = asInt(info.length, "info.length");
    if (length < 0) throw new AppError("METADATA_CORRUPT", "info.length 为负");
    const absPath = safeJoin(contentRoot, [name]);
    files = [{ pathParts: [name], relPath: name, length, offset: 0, absPath }];
    offset = length;
  }

  const totalLength = offset;
  if (totalLength > LIMITS.MAX_TOTAL_BYTES) {
    throw new AppError("TOO_LARGE", `内容总长度 ${totalLength} 超过上限 ${LIMITS.MAX_TOTAL_BYTES}`);
  }
  const expectedPieceCount = totalLength === 0 ? 0 : Math.ceil(totalLength / pieceLength);
  if (pieceHashes.length !== expectedPieceCount) {
    throw new AppError(
      "METADATA_CORRUPT",
      `pieces 数量(${pieceHashes.length}) 与总字节数推算的分片数(${expectedPieceCount})不一致`,
    );
  }
  if (totalLength === 0 && pieceHashes.length !== 0) {
    throw new AppError("METADATA_CORRUPT", "总长度为 0 时不应存在分片");
  }

  const [start, end] = infoSpan;
  const rawInfo = buf.subarray(start, end);
  const infoHash = createHash("sha1").update(rawInfo).digest("hex");

  return {
    infoHash,
    name,
    private_,
    pieceLength,
    pieceHashes,
    totalLength,
    expectedPieceCount,
    files,
    mode,
    rawInfo,
  };
}

/** 返回某个分片覆盖的全局字节区间 [start, end)。 */
export function pieceByteRange(meta: TorrentMeta, index: number): [number, number] {
  const start = index * meta.pieceLength;
  const end = Math.min(start + meta.pieceLength, meta.totalLength);
  return [start, end];
}

/** 找出与某全局区间相交的文件（用于错误分片定位）。 */
export function filesOverlapping(meta: TorrentMeta, start: number, end: number): TorrentFile[] {
  return meta.files.filter((f) => f.offset + f.length > start && f.offset < end);
}
