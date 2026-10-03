import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TorrentMeta } from "./torrent.js";
import type { VerifyReport } from "./verifier.js";

export interface TorrentRow {
  info_hash: string;
  name: string;
  mode: string;
  piece_length: number;
  total_length: number;
  piece_count: number;
  raw_info: Buffer;
  torrent_blob: Buffer;
  imported_at: string;
  source_name: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS torrents (
        info_hash     TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        mode          TEXT NOT NULL,
        piece_length  INTEGER NOT NULL,
        total_length  INTEGER NOT NULL,
        piece_count   INTEGER NOT NULL,
        raw_info      BLOB NOT NULL,
        torrent_blob  BLOB NOT NULL,
        source_name   TEXT,
        imported_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS torrent_files (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        info_hash     TEXT NOT NULL REFERENCES torrents(info_hash) ON DELETE CASCADE,
        idx           INTEGER NOT NULL,
        rel_path      TEXT NOT NULL,
        length        INTEGER NOT NULL,
        stream_offset INTEGER NOT NULL,
        UNIQUE(info_hash, idx)
      );

      CREATE TABLE IF NOT EXISTS reports (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        info_hash     TEXT NOT NULL REFERENCES torrents(info_hash) ON DELETE CASCADE,
        overall       TEXT NOT NULL,
        ok_count      INTEGER NOT NULL,
        failed_count  INTEGER NOT NULL,
        checked_at    TEXT NOT NULL,
        report_json   TEXT NOT NULL,
        UNIQUE(info_hash, checked_at)
      );

      CREATE INDEX IF NOT EXISTS idx_reports_hash ON reports(info_hash);
      CREATE INDEX IF NOT EXISTS idx_files_hash ON torrent_files(info_hash);
    `);
  }

  upsertTorrent(meta: TorrentMeta, torrentBlob: Buffer, sourceName: string | null): void {
    const stmt = this.db.prepare(`
      INSERT INTO torrents (info_hash, name, mode, piece_length, total_length, piece_count, raw_info, torrent_blob, source_name, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(info_hash) DO UPDATE SET
        name=excluded.name, mode=excluded.mode, piece_length=excluded.piece_length,
        total_length=excluded.total_length, piece_count=excluded.piece_count,
        raw_info=excluded.raw_info, torrent_blob=excluded.torrent_blob,
        source_name=excluded.source_name, imported_at=datetime('now')
    `);
    stmt.run(
      meta.infoHash,
      meta.name,
      meta.mode,
      meta.pieceLength,
      meta.totalLength,
      meta.expectedPieceCount,
      Buffer.from(meta.rawInfo),
      Buffer.from(torrentBlob),
      sourceName,
    );

    const del = this.db.prepare("DELETE FROM torrent_files WHERE info_hash = ?");
    del.run(meta.infoHash);
    const ins = this.db.prepare(
      "INSERT INTO torrent_files (info_hash, idx, rel_path, length, stream_offset) VALUES (?, ?, ?, ?, ?)",
    );
    meta.files.forEach((f, idx) => {
      ins.run(meta.infoHash, idx, f.relPath, f.length, f.offset);
    });
  }

  listTorrents(): TorrentRow[] {
    return this.db
      .prepare("SELECT * FROM torrents ORDER BY imported_at DESC")
      .all() as unknown as TorrentRow[];
  }

  getTorrent(infoHash: string): TorrentRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM torrents WHERE info_hash = ?")
        .get(infoHash.toLowerCase()) as TorrentRow | undefined) ?? null
    );
  }

  listFiles(infoHash: string): { idx: number; rel_path: string; length: number; stream_offset: number }[] {
    return this.db
      .prepare("SELECT idx, rel_path, length, stream_offset FROM torrent_files WHERE info_hash = ? ORDER BY idx")
      .all(infoHash.toLowerCase()) as never;
  }

  saveReport(report: VerifyReport): number {
    const ins = this.db.prepare(
      `INSERT INTO reports (info_hash, overall, ok_count, failed_count, checked_at, report_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = ins.run(
      report.infoHash,
      report.overallStatus,
      report.okCount,
      report.failedCount,
      report.checkedAt,
      JSON.stringify(report),
    );
    return Number(result.lastInsertRowid);
  }

  listReports(infoHash?: string): { id: number; info_hash: string; overall: string; ok_count: number; failed_count: number; checked_at: string }[] {
    if (infoHash) {
      return this.db
        .prepare("SELECT id, info_hash, overall, ok_count, failed_count, checked_at FROM reports WHERE info_hash = ? ORDER BY id DESC")
        .all(infoHash.toLowerCase()) as never;
    }
    return this.db
      .prepare("SELECT id, info_hash, overall, ok_count, failed_count, checked_at FROM reports ORDER BY id DESC")
      .all() as never;
  }

  getReport(id: number): VerifyReport | null {
    const row = this.db.prepare("SELECT report_json FROM reports WHERE id = ?").get(id) as
      | { report_json: string }
      | undefined;
    return row ? (JSON.parse(row.report_json) as VerifyReport) : null;
  }

  latestReport(infoHash: string): { id: number; report: VerifyReport } | null {
    const row = this.db
      .prepare("SELECT id, report_json FROM reports WHERE info_hash = ? ORDER BY id DESC LIMIT 1")
      .get(infoHash.toLowerCase()) as { id: number; report_json: string } | undefined;
    return row ? { id: row.id, report: JSON.parse(row.report_json) as VerifyReport } : null;
  }
}
