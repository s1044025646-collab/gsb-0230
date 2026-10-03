import { join, resolve } from "node:path";

/**
 * 明确的批量读取上限（需求要求声明）：
 * - MAX_TORRENT_SIZE：单个 .torrent 文件大小上限 16 MiB。
 * - MAX_PIECE_BATCH_BYTES：一次批量读取循环最多读 64 MiB，随后让出事件循环。
 * - MAX_TOTAL_BYTES：可校验内容总长度上限 20 GiB（避免误扫海量资源）。
 */
export const LIMITS = {
  MAX_TORRENT_SIZE: 16 * 1024 * 1024,
  MAX_PIECE_BATCH_BYTES: 64 * 1024 * 1024,
  MAX_TOTAL_BYTES: 20 * 1024 * 1024 * 1024,
  MIN_PIECE_LENGTH: 16 * 1024,
  MAX_PIECE_LENGTH: 64 * 1024 * 1024,
} as const;

export interface ResolvedConfig {
  sampleRoot: string;
  dataDir: string;
  dbPath: string;
  port: number | null;
}

export function projectRoot(): string {
  return resolve(import.meta.dirname, "..");
}

export function defaultDataDir(): string {
  return join(projectRoot(), "data");
}

export function defaultSampleRoot(): string {
  return join(projectRoot(), "samples");
}

export function resolveConfig(opts: {
  sampleRoot?: string;
  dataDir?: string;
  port?: number | null;
} = {}): ResolvedConfig {
  const dataDir = resolve(opts.dataDir ?? defaultDataDir());
  const sampleRoot = resolve(opts.sampleRoot ?? defaultSampleRoot());
  const dbPath = join(dataDir, "checker.db");
  return { sampleRoot, dataDir, dbPath, port: opts.port === undefined ? null : opts.port };
}

/** 选择一个空闲 TCP 端口（默认行为）。 */
export async function pickFreePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const p = addr.port;
        srv.close(() => res(p));
      } else {
        srv.close(() => rej(new Error("无法获取空闲端口")));
      }
    });
  });
}
