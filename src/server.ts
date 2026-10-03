import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.js';
import { CheckerService, ServiceError } from './service.js';
import { MetaError } from './torrent.js';
import { VerifyError } from './verifier.js';

const here = dirname(fileURLToPath(import.meta.url));
// 编译产物位于 dist/src/，上溯两级；tsx 直跑 src/ 时上溯一级
const projectRoot = resolve(here, here.includes(`${resolve('dist')}`) ? '../..' : '..');

export interface ServerOptions {
  port?: number; // 0 / 未指定 => 选择空闲端口
  dataDir?: string;
  samplesRoot?: string;
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => void;
}

export function pickFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        srv.close(() => rej(new Error('无法获取空闲端口')));
      }
    });
  });
}

function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        rej(new ServiceError('PAYLOAD_TOO_LARGE', `请求体超过 ${maxBytes} 字节上限`, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return res({});
      try {
        res(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rej(new ServiceError('BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', rej);
  });
}

export async function startServer(opts: ServerOptions = {}): Promise<StartedServer> {
  const dataDir = resolve(opts.dataDir ?? joinDefault('data'));
  const samplesRoot = resolve(opts.samplesRoot ?? joinDefault('samples'));
  const store = new Store(resolve(dataDir, 'checker.sqlite'));
  const service = new CheckerService(store);

  const server = createServer(async (req, res) => {
    await handle(req, res, service, samplesRoot);
  });

  const port = opts.port ?? (await pickFreePort());
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const actualPort = (server.address() as { port: number }).port;
  return {
    server,
    port: actualPort,
    close: () => {
      server.close();
      store.close();
    },
  };
}

function joinDefault(p: string): string {
  return resolve(projectRoot, p);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  service: CheckerService,
  samplesRoot: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  try {
    if (path === '/health' && method === 'GET') {
      return send(res, 200, { ok: true, service: 'bt-meta-checker', samplesRoot });
    }

    if (path === '/api/torrents' && method === 'GET') {
      return send(res, 200, { torrents: service.listTorrents() });
    }
    if (path === '/api/torrents' && method === 'POST') {
      const body = (await readJson(req)) as { torrentPath?: unknown };
      if (typeof body.torrentPath !== 'string' || body.torrentPath.trim() === '') {
        throw new ServiceError('MISSING_PARAM', '需要字符串参数 torrentPath');
      }
      const { torrentId, created, meta } = service.importTorrent(body.torrentPath);
      return send(res, created ? 201 : 200, {
        torrentId,
        created,
        infoHash: meta.infoHash,
        name: meta.name,
        pieceLength: meta.pieceLength,
        pieceCount: meta.pieceCount,
        totalLength: meta.totalLength,
        fileCount: meta.files.length,
        files: meta.files.map((f) => ({ path: f.path, length: f.length, offsetStart: f.offsetStart, offsetEnd: f.offsetEnd })),
      });
    }

    const mTorrent = path.match(/^\/api\/torrents\/([^/]+)$/);
    if (mTorrent && method === 'GET') {
      return send(res, 200, service.getTorrent(decodeParam(mTorrent[1])));
    }
    const mPieces = path.match(/^\/api\/torrents\/([^/]+)\/pieces$/);
    if (mPieces && method === 'GET') {
      return send(res, 200, service.listPieces(decodeParam(mPieces[1])));
    }
    const mPiece = path.match(/^\/api\/torrents\/([^/]+)\/pieces\/(\d+)$/);
    if (mPiece && method === 'GET') {
      return send(res, 200, service.getPiece(decodeParam(mPiece[1]), Number(mPiece[2])));
    }
    const mVerify = path.match(/^\/api\/torrents\/([^/]+)\/verify$/);
    if (mVerify && method === 'POST') {
      const body = (await readJson(req)) as { rootDir?: unknown };
      if (typeof body.rootDir !== 'string' || body.rootDir.trim() === '') {
        throw new ServiceError('MISSING_PARAM', '需要字符串参数 rootDir（相对样例根目录的子目录）');
      }
      const { reportId, report } = service.runVerify(decodeParam(mVerify[1]), body.rootDir, samplesRoot);
      return send(res, 201, { reportId, summary: summarize(report), report });
    }

    if (path === '/api/reports' && method === 'GET') {
      const torrentId = url.searchParams.get('torrentId');
      return send(res, 200, { reports: service.listReports(torrentId ? Number(torrentId) : undefined) });
    }
    const mReport = path.match(/^\/api\/reports\/(\d+)$/);
    if (mReport && method === 'GET') {
      const badOnly = url.searchParams.get('badOnly') === '1';
      return send(res, 200, service.getReport(Number(mReport[1]), badOnly));
    }
    const mReportPiece = path.match(/^\/api\/reports\/(\d+)\/pieces\/(\d+)$/);
    if (mReportPiece && method === 'GET') {
      return send(res, 200, service.reportPieceFiles(Number(mReportPiece[1]), Number(mReportPiece[2])));
    }
    const mExport = path.match(/^\/api\/reports\/(\d+)\/export$/);
    if (mExport && method === 'POST') {
      const body = (await readJson(req)) as { outPath?: unknown };
      if (typeof body.outPath !== 'string' || body.outPath.trim() === '') {
        throw new ServiceError('MISSING_PARAM', '需要字符串参数 outPath');
      }
      const written = service.exportReport(Number(mExport[1]), body.outPath);
      return send(res, 200, { exported: written });
    }

    return send(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: `${method} ${path}` } });
  } catch (e) {
    if (e instanceof ServiceError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    if (e instanceof MetaError) return send(res, 422, { error: { code: e.code, message: e.message } });
    if (e instanceof VerifyError) return send(res, e.code.startsWith('PATH') ? 403 : 400, { error: { code: e.code, message: e.message } });
    return send(res, 500, { error: { code: 'INTERNAL', message: (e as Error).message } });
  }
}

function decodeParam(p: string): string {
  return decodeURIComponent(p);
}

function summarize(r: { status: string; pieceCount: number; okCount: number; badCount: number; unreadableCount: number }) {
  return {
    status: r.status,
    pieceCount: r.pieceCount,
    okCount: r.okCount,
    badCount: r.badCount,
    unreadableCount: r.unreadableCount,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? Number(args[portArg + 1]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    console.error('端口必须是 0-65535 的整数（0 或省略表示自动选择空闲端口）');
    process.exit(2);
  }
  const dataArg = args.indexOf('--data');
  const samplesArg = args.indexOf('--samples');
  startServer({
    port,
    dataDir: dataArg >= 0 ? args[dataArg + 1] : undefined,
    samplesRoot: samplesArg >= 0 ? args[samplesArg + 1] : undefined,
  }).then(({ port: p }) => {
    console.log(`BitTorrent v1 本地校验服务已启动: http://127.0.0.1:${p}`);
    console.log('仅监听本机回环地址，不发起任何网络连接。');
  });
}
