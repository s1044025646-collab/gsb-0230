#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveConfig } from "./config.js";
import { AppError } from "./errors.js";
import { CheckerService } from "./service.js";
import { startServer } from "./server.js";
import type { VerifyReport } from "./verifier.js";

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) {
        flags.set(key.slice(0, eq), key.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(key, next);
          i += 1;
        } else {
          flags.set(key, true);
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function numFlag(flags: Map<string, string | boolean>, key: string): number | undefined {
  const v = flags.get(key);
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new AppError("BAD_REQUEST", `--${key} 必须是 1-65535 的整数端口`);
  }
  return n;
}

const HELP = [
  "bt-v1-checker —— 本地 BitTorrent v1 元信息与分片校验（离线，不联网）",
  "",
  "用法:",
  "  bt serve [--port 8080] [--sample-root <目录>] [--data-dir <目录>]",
  "  bt import <file.torrent>",
  "  bt list",
  "  bt files <infoHash>",
  "  bt pieces <infoHash>",
  "  bt verify <infoHash> [--root-rel <相对样例根的目录>] [--no-save]",
  "  bt failed-pieces <infoHash> [--report-id <id>]",
  "  bt reports [infoHash]",
  "  bt report <infoHash> [--report-id <id>]",
  "  bt save-report <infoHash> [--report-id <id>] [--out <文件>]",
  "  bt export <infoHash> --out <文件.json> [--report-id <id>]",
  "  bt help",
  "",
  "全局参数:",
  "  --sample-root <目录>   样例根目录（默认 项目/samples），内容路径必须在其下",
  "  --data-dir <目录>      数据目录（默认 项目/data，含 SQLite 与导出报告）",
  "  --api <baseUrl>        改为通过运行中的 HTTP API 执行（默认直接本地调用）",
  "",
  "退出码: 0 成功；1 业务错误（含校验 FAIL）；2 参数错误。",
].join("\n");

async function apiCall(base: string, path: string, init?: { method?: string; body?: Buffer; headers?: Record<string, string> }): Promise<unknown> {
  const resp = await fetch(base.replace(/\/$/, "") + path, {
    method: init?.method ?? "GET",
    body: init?.body as BodyInit | undefined,
    headers: init?.headers,
  });
  const text = await resp.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!resp.ok) {
    const e = json as { error?: string; message?: string } | null;
    throw new AppError((e?.error as never) ?? "INTERNAL", e?.message ?? `HTTP ${resp.status}`);
  }
  return json;
}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] ?? "help";
  if (cmd === "help" || flags.has("help")) {
    process.stdout.write(HELP + "\n");
    return 0;
  }

  const cfg = resolveConfig({
    sampleRoot: typeof flags.get("sample-root") === "string" ? (flags.get("sample-root") as string) : undefined,
    dataDir: typeof flags.get("data-dir") === "string" ? (flags.get("data-dir") as string) : undefined,
    port: numFlag(flags, "port"),
  });
  mkdirSync(cfg.dataDir, { recursive: true });
  const apiBase = typeof flags.get("api") === "string" ? (flags.get("api") as string) : null;

  if (cmd === "serve") {
    const started = await startServer(cfg, cfg.port ?? undefined);
    process.stdout.write(
      `服务已启动: http://127.0.0.1:${started.port}\n样例根目录: ${cfg.sampleRoot}\n数据库: ${cfg.dbPath}\n`,
    );
    process.on("SIGINT", () => {
      void started.close().then(() => process.exit(0));
    });
    return await new Promise<number>(() => {});
  }

  if (apiBase) {
    return await runViaApi(cmd, positional.slice(1), flags, apiBase);
  }

  const service = new CheckerService(cfg);
  try {
    return await runLocal(cmd, positional.slice(1), flags, service);
  } finally {
    service.close();
  }
}

async function runLocal(
  cmd: string,
  args: string[],
  flags: Map<string, string | boolean>,
  service: CheckerService,
): Promise<number> {
  switch (cmd) {
    case "import": {
      const file = args[0];
      if (!file) throw new AppError("BAD_REQUEST", "用法: bt import <file.torrent>");
      const { meta } = await service.importTorrentFile(file);
      print(summary(meta));
      return 0;
    }
    case "list":
      print({ torrents: service.listTorrents() });
      return 0;
    case "files": {
      const hash = requireHash(args);
      print({ files: service.listFiles(hash) });
      return 0;
    }
    case "pieces": {
      const hash = requireHash(args);
      print({ pieces: service.listPieceRanges(hash) });
      return 0;
    }
    case "verify": {
      const hash = requireHash(args);
      const rootRel = typeof flags.get("root-rel") === "string" ? (flags.get("root-rel") as string) : undefined;
      const { report, reportId } = await service.verify(hash, { rootRel, save: !flags.has("no-save") });
      print({ reportId: reportId ?? null, report: brief(report) });
      return report.overallStatus === "PASS" ? 0 : 1;
    }
    case "failed-pieces": {
      const hash = requireHash(args);
      const rid = numFlag(flags, "report-id");
      print({ failedPieces: service.failedPieces(hash, rid) });
      return 0;
    }
    case "reports":
      print({ reports: service.listReports(args[0]) });
      return 0;
    case "report": {
      const hash = requireHash(args);
      const rid = numFlag(flags, "report-id");
      print({ report: service.loadReport(hash, rid) });
      return 0;
    }
    case "save-report": {
      const hash = requireHash(args);
      const rid = numFlag(flags, "report-id");
      const out = typeof flags.get("out") === "string" ? (flags.get("out") as string) : undefined;
      const saved = await service.saveReportFile(hash, rid, out);
      print({ savedPath: saved });
      return 0;
    }
    case "export": {
      const hash = requireHash(args);
      const out = flags.get("out");
      if (typeof out !== "string") throw new AppError("BAD_REQUEST", "需要 --out <文件.json>");
      const rid = numFlag(flags, "report-id");
      await service.exportJson(hash, rid, out);
      print({ exported: true, outPath: resolve(out) });
      return 0;
    }
    default:
      throw new AppError("BAD_REQUEST", `未知命令: ${cmd}\n\n${HELP}`);
  }
}

async function runViaApi(
  cmd: string,
  args: string[],
  flags: Map<string, string | boolean>,
  base: string,
): Promise<number> {
  switch (cmd) {
    case "import": {
      const file = args[0];
      if (!file) throw new AppError("BAD_REQUEST", "用法: bt import <file.torrent>");
      const buf = readFileSync(file);
      const name = file.split(/[\\/]/).pop() ?? "upload.torrent";
      print(await apiCall(base, "/api/torrents", {
        method: "POST",
        body: buf,
        headers: { "content-type": "application/octet-stream", "x-torrent-name": name },
      }));
      return 0;
    }
    case "list":
      print(await apiCall(base, "/api/torrents"));
      return 0;
    case "files":
      print(await apiCall(base, `/api/torrents/${requireHash(args)}/files`));
      return 0;
    case "pieces":
      print(await apiCall(base, `/api/torrents/${requireHash(args)}/pieces`));
      return 0;
    case "verify": {
      const rootRel = typeof flags.get("root-rel") === "string" ? (flags.get("root-rel") as string) : undefined;
      const save = !flags.has("no-save");
      const json = (await apiCall(base, `/api/torrents/${requireHash(args)}/verify`, {
        method: "POST",
        body: Buffer.from(JSON.stringify({ rootRel, save })),
        headers: { "content-type": "application/json" },
      })) as { report: VerifyReport; reportId?: number };
      print({ reportId: json.reportId ?? null, report: brief(json.report) });
      return json.report.overallStatus === "PASS" ? 0 : 1;
    }
    case "failed-pieces": {
      const rid = numFlag(flags, "report-id");
      print(await apiCall(base, `/api/torrents/${requireHash(args)}/failed-pieces${rid ? `?reportId=${rid}` : ""}`));
      return 0;
    }
    case "reports":
      print(await apiCall(base, args[0] ? `/api/torrents/${args[0]}/reports` : "/api/reports"));
      return 0;
    case "save-report": {
      print(await apiCall(base, `/api/torrents/${requireHash(args)}/reports/0`, {
        method: "POST",
        body: Buffer.from("{}"),
      }));
      return 0;
    }
    case "export": {
      const hash = requireHash(args);
      const out = flags.get("out");
      if (typeof out !== "string") throw new AppError("BAD_REQUEST", "需要 --out <文件.json>");
      const rid = numFlag(flags, "report-id");
      print(await apiCall(base, `/api/torrents/${hash}/export`, {
        method: "POST",
        body: Buffer.from(JSON.stringify({ outPath: out, reportId: rid })),
        headers: { "content-type": "application/json" },
      }));
      return 0;
    }
    default:
      throw new AppError("BAD_REQUEST", `API 模式不支持命令: ${cmd}`);
  }
}

function requireHash(args: string[]): string {
  const h = args[0];
  if (!h || !/^[0-9a-fA-F]{40}$/.test(h)) {
    throw new AppError("BAD_REQUEST", "需要 40 位十六进制 info hash 参数");
  }
  return h.toLowerCase();
}

function summary(meta: {
  infoHash: string;
  name: string;
  mode: string;
  pieceLength: number;
  expectedPieceCount: number;
  totalLength: number;
  files: { relPath: string; length: number; offset: number }[];
}) {
  return {
    infoHash: meta.infoHash,
    name: meta.name,
    mode: meta.mode,
    pieceLength: meta.pieceLength,
    pieceCount: meta.expectedPieceCount,
    totalLength: meta.totalLength,
    files: meta.files.map((f, i) => ({ index: i, relPath: f.relPath, length: f.length, streamOffset: f.offset })),
  };
}

function brief(report: VerifyReport) {
  return {
    infoHash: report.infoHash,
    name: report.name,
    overallStatus: report.overallStatus,
    pieceCount: report.pieceCount,
    okCount: report.okCount,
    failedCount: report.failedCount,
    failedPieces: report.pieces.filter((p) => p.status !== "OK"),
  };
}

function print(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof AppError) {
      process.stderr.write(`错误[${err.code}] ${err.message}\n`);
      process.exit(err.code === "BAD_REQUEST" ? 2 : 1);
    }
    process.stderr.write(`错误[INTERNAL] ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
