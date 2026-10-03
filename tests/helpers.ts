import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
export const SAMPLES = join(PROJECT_ROOT, "samples");

const REGISTER = join(PROJECT_ROOT, "scripts", "register-ts.mjs");
const CLI = join(PROJECT_ROOT, "src", "cli.ts");

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `bt-${prefix}-`));
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], dataDir: string): CliResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--import", pathToFileURL(REGISTER).href, CLI, ...args, "--data-dir", dataDir],
      { cwd: PROJECT_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

export function parseJson<T>(r: CliResult): T {
  return JSON.parse(r.stdout) as T;
}

export function torrentPath(name: string): string {
  return join(SAMPLES, "torrents", name);
}

export function sampleFile(rel: string): string {
  return join(SAMPLES, rel);
}

export function sha1(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

/** 递归计算目录下所有文件的 size+mtime 快照，用于“未改动源文件”断言。 */
export function snapshotDir(dir: string): Record<string, { size: number; mtimeMs: number }> {
  const snap: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else snap[relative(p)] = { size: st.size, mtimeMs: st.mtimeMs };
    }
  };
  walk(dir);
  return snap;
}

function relative(p: string): string {
  return p.slice(PROJECT_ROOT.length + 1).replace(/\\/g, "/");
}

export { readFileSync, writeFileSync };
