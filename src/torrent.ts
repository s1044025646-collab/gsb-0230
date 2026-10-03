import { createHash } from 'node:crypto';
import { asBuf, asDict, asInt, asList, decode, type BValue } from './bencode.js';

export interface TorrentFile {
  pathParts: string[];
  path: string;
  length: number;
  offsetStart: number;
  offsetEnd: number;
}

export interface PieceRange {
  index: number;
  start: number;
  end: number;
  length: number;
  files: { path: string; fileStart: number; fileEnd: number }[];
}

export interface TorrentMeta {
  name: string;
  pieceLength: number;
  totalLength: number;
  pieceCount: number;
  isPrivate: boolean;
  pieces: Buffer;
  files: TorrentFile[];
  infoHash: string;
  infoHashBytes: Buffer;
  rawInfo: Buffer;
  createdBy?: string;
  comment?: string;
}

export class MetaError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const PATH_TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;

function validatePathSegments(parts: string[]): void {
  for (const raw of parts) {
    if (raw === '' || raw === '.' || raw === '..') {
      throw new MetaError('META_INVALID_PATH', `非法路径段: "${raw}"`);
    }
    if (/[\\/:*?"<>|\x00-\x1f]/.test(raw)) {
      throw new MetaError('META_INVALID_PATH', `路径段包含非法字符: "${raw}"`);
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(raw)) {
      throw new MetaError('META_INVALID_PATH', `路径段命中 Windows 保留名: "${raw}"`);
    }
  }
}

export function parseTorrent(raw: Buffer): TorrentMeta {
  let root: BValue;
  try {
    root = decode(raw);
  } catch (e) {
    throw new MetaError('META_BENCODE_CORRUPT', `torrent 不是合法 bencode: ${(e as Error).message}`);
  }
  const rootDict = asDict(root);
  const infoEntry = rootDict.entries.get('info');
  if (!infoEntry) throw new MetaError('META_NO_INFO', '缺少 info 字典');

  // info hash 取自原始文件中 info 字典的实际编码字节，不重新序列化
  const rawInfo = raw.subarray(infoEntry.start, infoEntry.end);
  const infoHashBytes = createHash('sha1').update(rawInfo).digest();

  const info = asDict(infoEntry.value);
  const getBuf = (k: string) => {
    const e = info.entries.get(k);
    return e ? asBuf(e.value) : undefined;
  };
  const getInt = (k: string) => {
    const e = info.entries.get(k);
    return e ? asInt(e.value) : undefined;
  };

  if (info.entries.has('meta version') || info.entries.has('file tree')) {
    throw new MetaError('META_V2_UNSUPPORTED', '检测到 BitTorrent v2 / 混合种子（meta version / file tree），仅支持 v1');
  }

  const pieces = getBuf('pieces');
  if (!pieces) throw new MetaError('META_NO_PIECES', 'info 缺少 pieces 字段');
  if (pieces.length % 20 !== 0) {
    throw new MetaError('META_PIECES_LENGTH', `pieces 长度 ${pieces.length} 不是 20 的正整数倍`);
  }
  const pieceLength = getInt('piece length');
  if (!pieceLength || pieceLength <= 0 || pieceLength > 0x7fffffff) {
    throw new MetaError('META_BAD_PIECE_LENGTH', `非法 piece length: ${pieceLength}`);
  }
  const name = getBuf('name')?.toString('utf8');
  if (!name) throw new MetaError('META_NO_NAME', 'info 缺少 name 字段');

  const files: TorrentFile[] = [];
  let totalLength = 0;

  if (info.entries.has('files')) {
    if (info.entries.has('length')) {
      throw new MetaError('META_CONFLICT', 'info 同时存在 length 与 files，定义冲突');
    }
    const list = asList(info.entries.get('files')!.value);
    for (const item of list) {
      const fd = asDict(item);
      const length = asInt(fd.entries.get('length')?.value);
      if (length < 0) throw new MetaError('META_BAD_LENGTH', `文件长度为负: ${length}`);
      const pathList = asList(fd.entries.get('path')?.value);
      if (pathList.length === 0) throw new MetaError('META_EMPTY_PATH', '多文件模式下存在空路径');
      const parts = pathList.map((p) => asBuf(p).toString('utf8'));
      if (PATH_TRAVERSAL.test(parts.join('/'))) {
        throw new MetaError('META_INVALID_PATH', `路径包含越界段: ${parts.join('/')}`);
      }
      validatePathSegments(parts);
      files.push({
        pathParts: parts,
        path: parts.join('/'),
        length,
        offsetStart: totalLength,
        offsetEnd: totalLength + length,
      });
      totalLength += length;
    }
    if (files.length === 0) throw new MetaError('META_NO_FILES', 'files 列表为空');
  } else {
    const length = getInt('length');
    if (length === undefined) throw new MetaError('META_NO_LENGTH', '单文件模式缺少 length');
    if (length < 0) throw new MetaError('META_BAD_LENGTH', `文件长度为负: ${length}`);
    validatePathSegments([name]);
    files.push({ pathParts: [name], path: name, length, offsetStart: 0, offsetEnd: length });
    totalLength = length;
  }

  const expectedPieces = Math.ceil(totalLength / pieceLength);
  if (pieces.length / 20 !== expectedPieces) {
    throw new MetaError(
      'META_PIECES_MISMATCH',
      `pieces 数量 ${pieces.length / 20} 与总字节 ${totalLength}、pieceLength ${pieceLength} 推导出的 ${expectedPieces} 不一致`,
    );
  }

  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new MetaError('META_DUP_PATH', `文件路径重复: ${f.path}`);
    seen.add(f.path);
  }

  return {
    name,
    pieceLength,
    totalLength,
    pieceCount: expectedPieces,
    isPrivate: getInt('private') === 1,
    pieces,
    files,
    infoHash: infoHashBytes.toString('hex'),
    infoHashBytes,
    rawInfo,
    createdBy: rootDict.entries.get('created by') ? asBuf(rootDict.entries.get('created by')!.value).toString('utf8') : undefined,
    comment: rootDict.entries.get('comment') ? asBuf(rootDict.entries.get('comment')!.value).toString('utf8') : undefined,
  };
}

export function pieceRange(meta: TorrentMeta, index: number): PieceRange {
  if (!Number.isInteger(index) || index < 0 || index >= meta.pieceCount) {
    throw new MetaError('BAD_PIECE_INDEX', `分片序号 ${index} 越界（共 ${meta.pieceCount} 片）`);
  }
  const start = index * meta.pieceLength;
  const end = Math.min(start + meta.pieceLength, meta.totalLength);
  const range: PieceRange = { index, start, end, length: end - start, files: [] };
  for (const f of meta.files) {
    if (f.offsetEnd <= start || f.offsetStart >= end) continue;
    range.files.push({
      path: f.path,
      fileStart: Math.max(0, start - f.offsetStart),
      fileEnd: Math.min(f.length, end - f.offsetStart),
    });
  }
  return range;
}

export function allPieceRanges(meta: TorrentMeta): PieceRange[] {
  const out: PieceRange[] = [];
  for (let i = 0; i < meta.pieceCount; i++) out.push(pieceRange(meta, i));
  return out;
}
