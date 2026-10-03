/**
 * 一键演示：生成样例（如已存在则跳过）→ 导入 → 各场景校验 → 失败片定位 → 保存/导出 JSON。
 * 使用独立数据目录 data/demo，不触碰样例文件。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveConfig } from "../src/config.ts";

const root = resolve(import.meta.dirname, "..");
const register = pathToFileURL(join(root, "scripts", "register-ts.mjs")).href;
const cli = join(root, "src", "cli.ts");

function run(args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--import", register, cli, ...args, "--data-dir", cfg.dbPath.replace(/[\\/]checker\.db$/, "")], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "" };
  }
}

function step(title: string): void {
  console.log(`\n===== ${title} =====`);
}

const cfg = resolveConfig({ dataDir: join(root, "data", "demo") });

if (!existsSync(join(root, "samples", "manifest.json"))) {
  step("生成样例");
  execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--import", register, join(root, "scripts", "gen-samples.ts")], {
    cwd: root,
    stdio: "inherit",
  });
}

step("导入多文件种子");
const imported = run(["import", join(root, "samples", "torrents", "multi.torrent")]);
console.log(imported.out);
const hash = (JSON.parse(imported.out) as { infoHash: string }).infoHash;

for (const scene of ["multi/good", "multi/bad-flip", "multi/missing", "multi/short"]) {
  step(`校验场景：${scene}`);
  const r = run(["verify", hash, "--root-rel", scene]);
  console.log(r.out.trim());
}

step("最近一次失败分片涉及的文件");
console.log(run(["failed-pieces", hash]).out.trim());

step("保存报告到数据目录");
console.log(run(["save-report", hash]).out.trim());

step("导出 JSON");
const exportPath = join(cfg.dataDir, "latest-report.json");
console.log(run(["export", hash, "--out", exportPath]).out.trim());
console.log(`\n演示完成。数据库位于：${cfg.dbPath}`);
