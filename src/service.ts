import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './db.js';
import { allPieceRanges, parseTorrent, pieceRange, type TorrentMeta } from './torrent.js';
import { badPieces, filesForPiece, safeResolve, verify, type VerifyReport } from './verifier.js';

export class ServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export class CheckerService {
  constructor(private store: Store) {}

  importTorrent(torrentPath: string): { torrentId: number; created: boolean; meta: TorrentMeta } {
    let raw: Buffer;
    try {
      raw = readFileSync(torrentPath);
    } catch {
      throw new ServiceError('TORRENT_UNREADABLE', `无法读取 torrent 文件: ${torrentPath}`, 404);
    }
    const meta = parseTorrent(raw);
    const { id, created } = this.store.upsertTorrent(meta, resolve(torrentPath));
    return { torrentId: id, created, meta };
  }

  listTorrents() {
    return this.store.listTorrents().map((t) => ({
      id: t.id,
      infoHash: t.info_hash,
      name: t.name,
      torrentPath: t.torrent_path,
      pieceLength: t.piece_length,
      totalLength: t.total_length,
      pieceCount: t.piece_count,
      fileCount: t.file_count,
      files: JSON.parse(t.files_json),
      pieces: JSON.parse(t.pieces_json),
      importedAt: t.imported_at,
    }));
  }

  getTorrent(idOrHash: string) {
    const t = this.store.getTorrent(idOrHash);
    if (!t) throw new ServiceError('NOT_FOUND', `未找到种子: ${idOrHash}`, 404);
    return {
      id: t.id,
      infoHash: t.info_hash,
      name: t.name,
      torrentPath: t.torrent_path,
      pieceLength: t.piece_length,
      totalLength: t.total_length,
      pieceCount: t.piece_count,
      files: JSON.parse(t.files_json),
      pieces: JSON.parse(t.pieces_json),
      importedAt: t.imported_at,
    };
  }

  listPieces(idOrHash: string) {
    const t = this.store.getTorrent(idOrHash);
    if (!t) throw new ServiceError('NOT_FOUND', `未找到种子: ${idOrHash}`, 404);
    const meta = this.metaFromStored(t);
    return {
      infoHash: t.info_hash,
      name: t.name,
      pieceLength: t.piece_length,
      totalLength: t.total_length,
      pieceCount: t.piece_count,
      pieces: allPieceRanges(meta),
    };
  }

  getPiece(idOrHash: string, index: number) {
    const t = this.store.getTorrent(idOrHash);
    if (!t) throw new ServiceError('NOT_FOUND', `未找到种子: ${idOrHash}`, 404);
    const meta = this.metaFromStored(t);
    return pieceRange(meta, index);
  }

  /** 校验：rootDir 必须在 allowedRoot 之内 */
  runVerify(idOrHash: string, rootDir: string, allowedRoot: string): { reportId: number; report: VerifyReport } {
    const t = this.store.getTorrent(idOrHash);
    if (!t) throw new ServiceError('NOT_FOUND', `未找到种子: ${idOrHash}`, 404);
    const meta = this.metaFromStored(t);
    const resolvedRoot = safeResolve(allowedRoot, '.');
    const target = safeResolve(allowedRoot, rootDir);
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new ServiceError('PATH_TRAVERSAL', `校验目录越出允许的样例根目录: ${rootDir}`, 403);
    }
    // 用种子文件路径无法重建 meta（rawInfo），但校验只需要结构化字段
    const report = verify(meta, target);
    const reportId = this.store.saveReport(t.id, report);
    return { reportId, report };
  }

  listReports(torrentId?: number) {
    return this.store.listReports(torrentId).map((r) => ({
      id: r.id,
      torrentId: r.torrent_id,
      infoHash: r.info_hash,
      rootDir: r.root_dir,
      status: r.status,
      okCount: r.ok_count,
      badCount: r.bad_count,
      unreadableCount: r.unreadable_count,
      verifiedAt: r.verified_at,
    }));
  }

  getReport(id: number, badOnly = false) {
    const r = this.store.getReport(id);
    if (!r) throw new ServiceError('NOT_FOUND', `未找到报告 #${id}`, 404);
    const report: VerifyReport = JSON.parse(r.report_json);
    if (badOnly) {
      return { ...report, pieces: badPieces(report) };
    }
    return report;
  }

  reportPieceFiles(reportId: number, index: number) {
    const r = this.store.getReport(reportId);
    if (!r) throw new ServiceError('NOT_FOUND', `未找到报告 #${reportId}`, 404);
    return filesForPiece(JSON.parse(r.report_json), index);
  }

  exportReport(reportId: number, outPath: string): string {
    const r = this.store.getReport(reportId);
    if (!r) throw new ServiceError('NOT_FOUND', `未找到报告 #${reportId}`, 404);
    const target = resolve(outPath);
    writeFileSync(target, JSON.stringify(JSON.parse(r.report_json), null, 2), 'utf8');
    return target;
  }

  private metaFromStored(t: ReturnType<Store['getTorrent']> & {}): TorrentMeta {
    const st = t!;
    const files = JSON.parse(st.files_json) as {
      path: string;
      length: number;
      offsetStart: number;
      offsetEnd: number;
    }[];
    const pieceCount = st.piece_count;
    const pieceHashes: string[] = JSON.parse(st.pieces_json);
    const pieces = Buffer.concat(pieceHashes.map((h) => Buffer.from(h, 'hex')));
    return {
      name: st.name,
      pieceLength: st.piece_length,
      totalLength: st.total_length,
      pieceCount,
      isPrivate: false,
      pieces,
      files: files.map((f) => ({ pathParts: f.path.split('/'), path: f.path, length: f.length, offsetStart: f.offsetStart, offsetEnd: f.offsetEnd })),
      infoHash: st.info_hash,
      infoHashBytes: Buffer.alloc(20),
      rawInfo: Buffer.alloc(0),
    };
  }
}
