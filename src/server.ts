import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pickFreePort, type ResolvedConfig } from "./config.js";
import { AppError, httpStatusFor } from "./errors.js";
import { CheckerService } from "./service.js";

interface Json {
  [key: string]: unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new AppError("TOO_LARGE", `请求体超过 ${limit} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(cfg: ResolvedConfig, requestedPort?: number): Promise<StartedServer> {
  const service = new CheckerService(cfg);
  const port = requestedPort ?? (await pickFreePort());

  const server = createServer((req, res) => {
    handle(req, res, service).catch((err) => {
      if (err instanceof AppError) {
        sendJson(res, httpStatusFor(err.code), { error: err.code, message: err.message, details: err.details ?? null });
      } else {
        sendJson(res, 500, { error: "INTERNAL", message: (err as Error).message });
      }
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });

  return {
    server,
    port,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      service.close();
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, service: CheckerService): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/health") {
    sendJson(res, 200, { ok: true, sampleRoot: cfg_sampleRoot(service), limits: healthLimits() });
    return;
  }

  if (method === "POST" && path === "/api/torrents") {
    const body = await readBody(req, 16 * 1024 * 1024 + 1024);
    const sourceName = req.headers["x-torrent-name"];
    const { meta } = await service.importTorrent(body, Array.isArray(sourceName) ? sourceName[0]! : (sourceName ?? null));
    sendJson(res, 201, torrentSummary(meta));
    return;
  }

  let m = path.match(/^\/api\/torrents\/([0-9a-fA-F]{40})$/);
  if (method === "GET" && m) {
    const meta = service.getMeta(m[1]!);
    sendJson(res, 200, torrentSummary(meta));
    return;
  }

  if (method === "GET" && path === "/api/torrents") {
    sendJson(res, 200, { torrents: service.listTorrents() });
    return;
  }

  m = path.match(/^\/api\/torrents\/([0-9a-fA-F]{40})\/files$/);
  if (method === "GET" && m) {
    sendJson(res, 200, { files: service.listFiles(m[1]!) });
    return;
  }

  m = path.match(/^\/api\/torrents\/([0-9a-fA-F]{40})\/pieces$/);
  if (method === "GET" && m) {
    sendJson(res, 200, { pieces: service.listPieceRanges(m[1]!) });
    return;
  }

  m = path.match(/^\/api\/torrents\/([0-9a-fA-F]{40})\/verify$/);
  if (method === "POST" && m) {
    let body: Json = {};
    const raw = await readBody(req, 1024 * 1024);
    if (raw.length > 0) body = JSON.parse(raw.toString("utf8")) as Json;
    const rootRel = typeof body.rootRel === "string" ? body.rootRel : undefined;
    const save = body.save === false ? false : true;
    const { report, reportId } = await service.verify(m[1]!, { rootRel, save });
    sendJson(res, 200, { reportId: reportId ?? null, report });
    return;
  }

  m = path.match(/^\/api\/torrents\/([0-9a-fA-F]{40})\/failed-pieces$/);
  if (method === "GET" && m) {
    const reportId = url.searchParams.get("reportId");
    const pieces = service.failedPieces(m[1]!, reportId ? Number(reportId) : undefined);
    sendJson(res, 200, { failedPieces: pieces });
    return;
  }

  m = path.match(/^\/api\/torrents\/([0-9a-fA-F]{40})\/reports$/);
  if (method === "GET" && m) {
    sendJson(res, 200, { reports: service.listReports(m[1]!) });
    return;
  }

  m = path.match(/^\/api\/torrents\/([0-9a-fA-F]{40})\/reports\/(\d+)$/);
  if (method === "GET" && m) {
    const report = service.loadReport(m[1]!, Number(m[2]));
    sendJson(res, 200, { report });
    return;
  }
  if (method === "POST" && m) {
    const savedPath = await service.saveReportFile(m[1]!, Number(m[2]));
    sendJson(res, 200, { savedPath });
    return;
  }

  m = path.match(/^\/api\/torrents\/([0-9a-fA-F]{40})\/export$/);
  if (method === "POST" && m) {
    let body: Json = {};
    const raw = await readBody(req, 1024 * 1024);
    if (raw.length > 0) body = JSON.parse(raw.toString("utf8")) as Json;
    if (typeof body.outPath !== "string" || body.outPath.length === 0) {
      throw new AppError("BAD_REQUEST", "缺少 outPath 参数");
    }
    const reportId = typeof body.reportId === "number" ? body.reportId : undefined;
    await service.exportJson(m[1]!, reportId, body.outPath);
    sendJson(res, 200, { exported: true, outPath: body.outPath });
    return;
  }

  if (method === "GET" && path === "/api/reports") {
    const h = url.searchParams.get("infoHash") ?? undefined;
    sendJson(res, 200, { reports: service.listReports(h) });
    return;
  }

  sendJson(res, 404, { error: "NOT_FOUND", message: `无此接口：${method} ${path}` });
}

function torrentSummary(meta: import("./torrent.js").TorrentMeta) {
  return {
    infoHash: meta.infoHash,
    name: meta.name,
    mode: meta.mode,
    private: meta.private_,
    pieceLength: meta.pieceLength,
    pieceCount: meta.expectedPieceCount,
    totalLength: meta.totalLength,
    files: meta.files.map((f, i) => ({
      index: i,
      relPath: f.relPath,
      length: f.length,
      streamOffset: f.offset,
    })),
  };
}

function cfg_sampleRoot(service: CheckerService): string {
  return (service as unknown as { cfg: ResolvedConfig }).cfg.sampleRoot;
}

function healthLimits() {
  return {
    maxTorrentSizeBytes: 16 * 1024 * 1024,
    maxPieceBatchBytes: 64 * 1024 * 1024,
    maxTotalBytes: 20 * 1024 * 1024 * 1024,
  };
}
