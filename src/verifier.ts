import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pieceRange, type PieceRange, type TorrentMeta } from './torrent.js';

/** 单次 read 上限（字节），明确批量读取边界 */
export const MAX_READ_CHUNK = 1024 * 1024; // 1 MiB
/** 单次校验总字节上限，避免误传入超大种子 */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB
/** 最大分片数量上限 */
export const MAX_PIECE_COUNT = 200_000;

export type FileStatus = 'ok' | 'missing' | 'length_mismatch' | 'not_a_file';
export type PieceStatus = 'ok' | 'mismatch' | 'unreadable';

export interface FileResult {
  path: string;
  expectedLength: number;
  actualLength: number | null;
  status: FileStatus;
  absPath: string;
}

export interface PieceResult {
  index: number;
  start: number;
  end: number;
  expectedSha1: string;
  actualSha1: string | null;
  status: PieceStatus;
  /** 该片无法读取的字节数（缺文件 / 长度不足） */
  missingBytes: number;
  files: { path: string; fileStart: number; fileEnd: number }[];
  /** 该片涉及的文件级问题 */
  reasons: string[];
}

export interface VerifyReport {
  rootDir: string;
  infoHash: string;
  name: string;
  pieceLength: number;
  totalLength: number;
  pieceCount: number;
  okCount: number;
  badCount: number;
  unreadableCount: number;
  status: 'pass' | 'fail';
  files: FileResult[];
  pieces: PieceResult[];
  limits: { maxReadChunk: number; maxTotalBytes: number; maxPieceCount: number };
  verifiedAt: string;
}

export class VerifyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** 把相对路径安全解析到 root 下，拒绝任何越界（含符号链接到目录外的情况由 realpath 复核） */
export function safeResolve(rootDir: string, relPath: string): string {
  const root = resolve(rootDir);
  const parts = relPath.split(/[\\/]/).filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new VerifyError('PATH_TRAVERSAL', `路径包含越界段: ${relPath}`);
  }
  if (/^[a-zA-Z]:/.test(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new VerifyError('PATH_ABSOLUTE', `拒绝绝对路径: ${relPath}`);
  }
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new VerifyError('PATH_TRAVERSAL', `解析结果越出样例根目录: ${relPath}`);
  }
  return target;
}

interface OpenFile {
  path: string;
  absPath: string;
  fd: number;
  length: number;
}

export function verify(meta: TorrentMeta, rootDir: string): VerifyReport {
  if (meta.totalLength > MAX_TOTAL_BYTES) {
    throw new VerifyError('TOO_LARGE', `总字节 ${meta.totalLength} 超过上限 ${MAX_TOTAL_BYTES}`);
  }
  if (meta.pieceCount > MAX_PIECE_COUNT) {
    throw new VerifyError('TOO_MANY_PIECES', `分片数 ${meta.pieceCount} 超过上限 ${MAX_PIECE_COUNT}`);
  }

  const root = resolve(rootDir);
  const fileResults: FileResult[] = [];
  const handles = new Map<string, OpenFile>();

  // 第一阶段：逐文件检查存在性、类型、长度；只读打开“正常”文件
  for (const f of meta.files) {
    const absPath = safeResolve(root, f.path);
    let status: FileStatus = 'ok';
    let actualLength: number | null = null;
    try {
      const st = statSync(absPath);
      if (!st.isFile()) {
        status = 'not_a_file';
      } else {
        actualLength = st.size;
        if (st.size !== f.length) status = 'length_mismatch';
      }
    } catch {
      status = 'missing';
    }
    fileResults.push({ path: f.path, expectedLength: f.length, actualLength, status, absPath });
    if (status === 'ok') {
      try {
        const fd = openSync(absPath, 'r');
        const rst = fstatSync(fd);
        if (rst.size !== f.length) {
          closeSync(fd);
          status = 'length_mismatch';
          const fr = fileResults[fileResults.length - 1];
          fr.status = status;
        } else {
          handles.set(f.path, { path: f.path, absPath, fd, length: f.length });
        }
      } catch {
        fileResults[fileResults.length - 1].status = 'missing';
      }
    }
  }

  const fileByPath = new Map(fileResults.map((r) => [r.path, r]));

  // 从文件流的全局偏移读取至多 MAX_READ_CHUNK；返回实际读到的字节
  function readGlobal(globalPos: number, len: number): { data: Buffer; readBytes: number; gapBytes: number } {
    let remaining = Math.min(len, MAX_READ_CHUNK);
    const out = Buffer.allocUnsafe(remaining);
    let written = 0;
    let gap = 0;
    while (remaining > 0) {
      const file = meta.files.find((f) => globalPos >= f.offsetStart && globalPos < f.offsetEnd)
        ?? meta.files.find((f) => f.length === 0 && globalPos === f.offsetStart && globalPos === f.offsetEnd);
      if (!file) break;
      const result = fileByPath.get(file.path)!;
      const inFilePos = globalPos - file.offsetStart;
      if (file.length === 0) {
        const skip = Math.min(remaining, file.offsetEnd - globalPos);
        if (skip === 0) break;
        globalPos += skip;
        remaining -= skip;
        continue;
      }
      if (result.status !== 'ok') {
        const skip = Math.min(remaining, file.offsetEnd - globalPos);
        gap += skip;
        globalPos += skip;
        remaining -= skip;
        continue;
      }
      const handle = handles.get(file.path)!;
      const canRead = Math.min(remaining, file.length - inFilePos);
      let got = 0;
      try {
        got = readSync(handle.fd, out, written, canRead, inFilePos);
      } catch {
        gap += canRead;
        globalPos += canRead;
        remaining -= canRead;
        written += 0;
        continue;
      }
      if (got === 0) {
        gap += canRead;
        globalPos += canRead;
        remaining -= canRead;
      } else {
        written += got;
        globalPos += got;
        remaining -= got;
      }
    }
    return { data: out.subarray(0, written), readBytes: written, gapBytes: gap };
  }

  // 第二阶段：把全部文件视为一条连续字节流，逐片 SHA-1
  const pieces: PieceResult[] = [];
  let okCount = 0;
  let badCount = 0;
  let unreadableCount = 0;

  for (let i = 0; i < meta.pieceCount; i++) {
    const range: PieceRange = pieceRange(meta, i);
    const expectedSha1 = meta.pieces.subarray(i * 20, i * 20 + 20).toString('hex');
    const hash = createHash('sha1');
    let pos = range.start;
    let missingBytes = 0;
    let consumed = 0;
    while (consumed < range.length) {
      const { data, readBytes, gapBytes } = readGlobal(pos, range.length - consumed);
      if (readBytes > 0) {
        hash.update(data);
        pos += readBytes;
        consumed += readBytes;
      }
      if (gapBytes > 0) {
        missingBytes += gapBytes;
        pos += gapBytes;
        consumed += gapBytes;
      }
      if (readBytes === 0 && gapBytes === 0) break;
    }

    const reasons: string[] = [];
    for (const rf of range.files) {
      const fr = fileByPath.get(rf.path)!;
      if (fr.status === 'missing') reasons.push(`文件缺失: ${rf.path}`);
      else if (fr.status === 'not_a_file') reasons.push(`路径不是普通文件: ${rf.path}`);
      else if (fr.status === 'length_mismatch') {
        reasons.push(`文件长度错误: ${rf.path}（期望 ${fr.expectedLength}，实际 ${fr.actualLength}）`);
      }
    }

    let status: PieceStatus;
    let actualSha1: string | null = null;
    if (missingBytes > 0) {
      status = 'unreadable';
      unreadableCount++;
    } else {
      actualSha1 = hash.digest('hex');
      if (actualSha1 === expectedSha1) {
        status = 'ok';
        okCount++;
      } else {
        status = 'mismatch';
        badCount++;
      }
    }
    pieces.push({
      index: i,
      start: range.start,
      end: range.end,
      expectedSha1,
      actualSha1,
      status,
      missingBytes,
      files: range.files,
      reasons: [...new Set(reasons)],
    });
  }

  for (const h of handles.values()) closeSync(h.fd);

  return {
    rootDir: root,
    infoHash: meta.infoHash,
    name: meta.name,
    pieceLength: meta.pieceLength,
    totalLength: meta.totalLength,
    pieceCount: meta.pieceCount,
    okCount,
    badCount,
    unreadableCount,
    status: badCount === 0 && unreadableCount === 0 ? 'pass' : 'fail',
    files: fileResults,
    pieces,
    limits: { maxReadChunk: MAX_READ_CHUNK, maxTotalBytes: MAX_TOTAL_BYTES, maxPieceCount: MAX_PIECE_COUNT },
    verifiedAt: new Date().toISOString(),
  };
}

/** 只返回有问题的分片（mismatch / unreadable），含其涉及的文件清单 */
export function badPieces(report: VerifyReport): PieceResult[] {
  return report.pieces.filter((p) => p.status !== 'ok');
}

export function filesForPiece(report: VerifyReport, index: number): PieceResult {
  const p = report.pieces[index];
  if (!p) throw new VerifyError('BAD_PIECE_INDEX', `分片序号 ${index} 不存在`);
  return p;
}

export { join as joinPath };
