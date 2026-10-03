import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TorrentMeta } from './torrent.js';
import type { VerifyReport } from './verifier.js';

export interface StoredTorrent {
  id: number;
  info_hash: string;
  name: string;
  torrent_path: string;
  piece_length: number;
  total_length: number;
  piece_count: number;
  file_count: number;
  files_json: string;
  pieces_json: string;
  imported_at: string;
}

export interface StoredReport {
  id: number;
  torrent_id: number;
  info_hash: string;
  root_dir: string;
  status: string;
  ok_count: number;
  bad_count: number;
  unreadable_count: number;
  report_json: string;
  verified_at: string;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS torrents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        info_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        torrent_path TEXT NOT NULL,
        piece_length INTEGER NOT NULL,
        total_length INTEGER NOT NULL,
        piece_count INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        files_json TEXT NOT NULL,
        pieces_json TEXT NOT NULL DEFAULT '[]',
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        torrent_id INTEGER NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
        info_hash TEXT NOT NULL,
        root_dir TEXT NOT NULL,
        status TEXT NOT NULL,
        ok_count INTEGER NOT NULL,
        bad_count INTEGER NOT NULL,
        unreadable_count INTEGER NOT NULL,
        report_json TEXT NOT NULL,
        verified_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reports_torrent ON reports(torrent_id);
      CREATE INDEX IF NOT EXISTS idx_reports_hash ON reports(info_hash);
    `);
  }

  upsertTorrent(meta: TorrentMeta, torrentPath: string): { id: number; created: boolean } {
    const existing = this.db
      .prepare('SELECT id FROM torrents WHERE info_hash = ?')
      .get(meta.infoHash) as { id: number } | undefined;
    const filesJson = JSON.stringify(
      meta.files.map((f) => ({ path: f.path, length: f.length, offsetStart: f.offsetStart, offsetEnd: f.offsetEnd })),
    );
    const piecesJson = JSON.stringify(
      Array.from({ length: meta.pieceCount }, (_, i) => meta.pieces.subarray(i * 20, i * 20 + 20).toString('hex')),
    );
    if (existing) {
      this.db
        .prepare(
          `UPDATE torrents SET name=?, torrent_path=?, piece_length=?, total_length=?, piece_count=?, file_count=?, files_json=?, pieces_json=? WHERE id=?`,
        )
        .run(
          meta.name,
          torrentPath,
          meta.pieceLength,
          meta.totalLength,
          meta.pieceCount,
          meta.files.length,
          filesJson,
          piecesJson,
          existing.id,
        );
      return { id: existing.id, created: false };
    }
    const res = this.db
      .prepare(
        `INSERT INTO torrents (info_hash,name,torrent_path,piece_length,total_length,piece_count,file_count,files_json,pieces_json,imported_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        meta.infoHash,
        meta.name,
        torrentPath,
        meta.pieceLength,
        meta.totalLength,
        meta.pieceCount,
        meta.files.length,
        filesJson,
        piecesJson,
        new Date().toISOString(),
      );
    return { id: Number(res.lastInsertRowid), created: true };
  }

  saveReport(torrentId: number, report: VerifyReport): number {
    const res = this.db
      .prepare(
        `INSERT INTO reports (torrent_id,info_hash,root_dir,status,ok_count,bad_count,unreadable_count,report_json,verified_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        torrentId,
        report.infoHash,
        report.rootDir,
        report.status,
        report.okCount,
        report.badCount,
        report.unreadableCount,
        JSON.stringify(report),
        report.verifiedAt,
      );
    return Number(res.lastInsertRowid);
  }

  listTorrents(): StoredTorrent[] {
    return this.db.prepare('SELECT * FROM torrents ORDER BY id').all() as unknown as StoredTorrent[];
  }

  getTorrent(idOrHash: string): StoredTorrent | undefined {
    if (/^\d+$/.test(idOrHash)) {
      return this.db.prepare('SELECT * FROM torrents WHERE id = ?').get(Number(idOrHash)) as StoredTorrent | undefined;
    }
    return this.db.prepare('SELECT * FROM torrents WHERE info_hash = ?').get(idOrHash.toLowerCase()) as
      | StoredTorrent
      | undefined;
  }

  listReports(torrentId?: number): StoredReport[] {
    if (torrentId !== undefined) {
      return this.db
        .prepare('SELECT * FROM reports WHERE torrent_id = ? ORDER BY id DESC')
        .all(torrentId) as unknown as StoredReport[];
    }
    return this.db.prepare('SELECT * FROM reports ORDER BY id DESC').all() as unknown as StoredReport[];
  }

  getReport(id: number): StoredReport | undefined {
    return this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as StoredReport | undefined;
  }

  close(): void {
    this.db.close();
  }
}
