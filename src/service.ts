import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { LIMITS, type ResolvedConfig } from "./config.js";
import { Store } from "./db.js";
import { AppError } from "./errors.js";
import { safeRootedDir } from "./safe-path.js";
import { filesOverlapping, pieceByteRange, parseTorrent, type TorrentMeta } from "./torrent.js";
import { failedPieces, verifyTorrent, type VerifyReport } from "./verifier.js";

export interface PieceRangeView {
  index: number;
  start: number;
  end: number;
  length: number;
  expectedSha1: string;
  files: { relPath: string; length: number; offset: number }[];
}

export class CheckerService {
  readonly store: Store;
  private readonly cfg: ResolvedConfig;
  constructor(cfg: ResolvedConfig) {
    this.cfg = cfg;
    this.store = new Store(cfg.dbPath);
  }

  close(): void {
    this.store.close();
  }

  /** 从磁盘导入 .torrent 文件。 */
  async importTorrentFile(torrentPath: string): Promise<{ meta: TorrentMeta; reportId?: number }> {
    const abs = isAbsolute(torrentPath) ? torrentPath : resolve(process.cwd(), torrentPath);
    const buf = await readFile(abs);
    return await this.importTorrent(buf, torrentPath.split(/[\\/]/).pop() ?? null);
  }

  async importTorrent(buf: Buffer, sourceName: string | null): Promise<{ meta: TorrentMeta; reportId?: number }> {
    if (buf.length === 0) throw new AppError("BAD_REQUEST", "种子内容为空");
    if (buf.length > LIMITS.MAX_TORRENT_SIZE) {
      throw new AppError("TOO_LARGE", `种子超过 ${LIMITS.MAX_TORRENT_SIZE} 字节上限`);
    }
    const meta = parseTorrent(buf, this.cfg.sampleRoot);
    this.store.upsertTorrent(meta, buf, sourceName);
    return { meta };
  }

  listTorrents() {
    return this.store.listTorrents().map((row) => ({
      infoHash: row.info_hash,
      name: row.name,
      mode: row.mode,
      pieceLength: row.piece_length,
      totalLength: row.total_length,
      pieceCount: row.piece_count,
      importedAt: row.imported_at,
      sourceName: row.source_name,
    }));
  }

  getMeta(infoHash: string): TorrentMeta {
    const row = this.store.getTorrent(infoHash);
    if (!row) throw new AppError("NOT_FOUND", `未找到种子：${infoHash}`);
    return parseTorrent(Buffer.from(row.torrent_blob), this.cfg.sampleRoot);
  }

  listFiles(infoHash: string) {
    this.getMeta(infoHash); // 存在性检查
    return this.store.listFiles(infoHash).map((f) => ({
      index: f.idx,
      relPath: f.rel_path,
      length: f.length,
      streamOffset: f.stream_offset,
    }));
  }

  listPieceRanges(infoHash: string): PieceRangeView[] {
    const meta = this.getMeta(infoHash);
    const views: PieceRangeView[] = [];
    for (let i = 0; i < meta.expectedPieceCount; i += 1) {
      const [start, end] = pieceByteRange(meta, i);
      views.push({
        index: i,
        start,
        end,
        length: end - start,
        expectedSha1: meta.pieceHashes[i]!.toString("hex"),
        files: filesOverlapping(meta, start, end).map((f) => ({
          relPath: f.relPath,
          length: f.length,
          offset: f.offset,
        })),
      });
    }
    return views;
  }

  /**
   * 校验内容。rootRel 为相对样例根的子目录（默认在根下直接按 name 解析）。
   * 这里种子文件路径本身已在导入时固定；rootRel 仅用于在样例根内切换不同场景目录。
   */
  async verify(infoHash: string, opts: { rootRel?: string; save?: boolean } = {}): Promise<{
    report: VerifyReport;
    reportId?: number;
  }> {
    const row = this.store.getTorrent(infoHash);
    if (!row) throw new AppError("NOT_FOUND", `未找到种子：${infoHash}`);
    // 内容根：样例根/<rootRel>（如 multi/good），种子文件按 name 在其下解析。
    const relDir = opts.rootRel ?? "";
    const base = relDir ? safeRootedDir(this.cfg.sampleRoot, relDir) : this.cfg.sampleRoot;
    const meta = parseTorrent(Buffer.from(row.torrent_blob), base);
    const report = await verifyTorrent(meta);
    let reportId: number | undefined;
    if (opts.save !== false) {
      reportId = this.store.saveReport(report);
    }
    return { report, reportId };
  }

  failedPieces(infoHash: string, reportId?: number) {
    const report = this.loadReport(infoHash, reportId);
    return failedPieces(report);
  }

  loadReport(infoHash: string, reportId?: number): VerifyReport {
    this.getMeta(infoHash);
    if (reportId !== undefined) {
      const r = this.store.getReport(reportId);
      if (!r || r.infoHash !== infoHash.toLowerCase()) {
        throw new AppError("NOT_FOUND", `未找到报告 #${reportId}`);
      }
      return r;
    }
    const latest = this.store.latestReport(infoHash);
    if (!latest) throw new AppError("NOT_FOUND", `该种子尚无校验报告：${infoHash}`);
    return latest.report;
  }

  listReports(infoHash?: string) {
    return this.store.listReports(infoHash);
  }

  /** 保存报告到项目内 data/reports（只读源文件，不修改任何样例）。 */
  async saveReportFile(infoHash: string, reportId: number | undefined, outPath?: string): Promise<string> {
    const report = this.loadReport(infoHash, reportId);
    const target = resolve(
      outPath ??
        resolve(this.cfg.dataDir, "reports", `${infoHash.toLowerCase()}-${report.checkedAt.replace(/[:.]/g, "-")}.json`),
    );
    if (!target.toLowerCase().startsWith(this.cfg.dataDir.toLowerCase())) {
      const forced = outPath;
      if (!forced) throw new AppError("PATH_TRAVERSAL", "报告导出路径越出数据目录");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2), "utf8");
    return target;
  }

  async exportJson(infoHash: string, reportId: number | undefined, outPath: string): Promise<void> {
    const report = this.loadReport(infoHash, reportId);
    const abs = isAbsolute(outPath) ? outPath : resolve(process.cwd(), outPath);
    writeFileSync(abs, JSON.stringify(report, null, 2), "utf8");
  }
}
