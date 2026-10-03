import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeTempDir, parseJson, runCli, torrentPath, SAMPLES } from "./helpers.ts";
import { startServer } from "../src/server.ts";
import { resolveConfig } from "../src/config.ts";
import { CheckerService } from "../src/service.ts";

test("CLI 全流程：导入→列出→分片范围→校验→失败片→报告→保存→导出", () => {
  const dataDir = makeTempDir("cli");
  const imported = parseJson<{ infoHash: string; pieceCount: number; files: { relPath: string }[] }>(
    runCli(["import", torrentPath("multi.torrent")], dataDir),
  );
  assert.equal(imported.pieceCount, 4);
  assert.ok(imported.files.some((f) => f.relPath === "multi-demo/empty.txt"));
  const hash = imported.infoHash;

  const list = parseJson<{ torrents: { info_hash?: string; infoHash?: string }[] }>(runCli(["list"], dataDir));
  assert.equal(list.torrents.length, 1);

  const pieces = parseJson<{ pieces: { index: number; files: { relPath: string }[] }[] }>(
    runCli(["pieces", hash], dataDir),
  );
  assert.equal(pieces.pieces.length, 4);
  assert.ok(pieces.pieces[0]!.files.length >= 2, "片0应横跨至少两个文件");

  const good = runCli(["verify", hash, "--root-rel", "multi/good"], dataDir);
  assert.equal(good.code, 0, good.stderr);
  const bad = runCli(["verify", hash, "--root-rel", "multi/bad-flip"], dataDir);
  assert.equal(bad.code, 1, "校验 FAIL 时退出码应为 1");
  const badJson = parseJson<{ report: { failedCount: number } }>(bad);
  assert.equal(badJson.report.failedCount, 1);

  const failed = parseJson<{ failedPieces: { index: number }[] }>(runCli(["failed-pieces", hash], dataDir));
  assert.equal(failed.failedPieces[0]!.index, 1);

  const reports = parseJson<{ reports: { id: number }[] }>(runCli(["reports", hash], dataDir));
  assert.equal(reports.reports.length, 2);
  const rid = reports.reports[1]!.id;

  const got = runCli(["report", hash, "--report-id", String(rid)], dataDir);
  assert.equal(got.code, 0);

  const save = parseJson<{ savedPath: string }>(runCli(["save-report", hash, "--report-id", String(rid)], dataDir));
  assert.match(save.savedPath, /reports/);

  const outFile = join(dataDir, "export.json");
  const exp = parseJson<{ exported: boolean }>(runCli(["export", hash, "--out", outFile, "--report-id", String(rid)], dataDir));
  assert.equal(exp.exported, true);
});

test("CLI 参数校验：坏 hash 退出码 2；损坏种子退出码 1", () => {
  const dataDir = makeTempDir("cli-err");
  const badHash = runCli(["pieces", "abc"], dataDir);
  assert.equal(badHash.code, 2);
  const corrupt = runCli(["import", torrentPath("multi.corrupt.torrent")], dataDir);
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.stderr, /METADATA_CORRUPT/);
  const evil = runCli(["import", torrentPath("evil-traversal.torrent")], dataDir);
  assert.match(evil.stderr, /PATH_TRAVERSAL/);
});

test("服务重启后仍能查询旧报告（SQLite 持久化）", () => {
  const dataDir = makeTempDir("persist");
  const imported = parseJson<{ infoHash: string }>(runCli(["import", torrentPath("single.torrent")], dataDir));
  const hash = imported.infoHash;
  const verifyRes = runCli(["verify", hash, "--root-rel", "single/good"], dataDir);
  assert.equal(verifyRes.code, 0);

  // 模拟“重启”：新建一个指向同一数据目录的 service 实例
  const cfg = resolveConfig({ dataDir, sampleRoot: SAMPLES });
  const service = new CheckerService(cfg);
  try {
    const reports = service.listReports(hash);
    assert.equal(reports.length, 1);
    const report = service.loadReport(hash);
    assert.equal(report.overallStatus, "PASS");
    assert.equal(report.pieceCount, 2);
  } finally {
    service.close();
  }
});

test("HTTP API：导入、校验、错误码与 404", async () => {
  const dataDir = makeTempDir("api");
  const cfg = resolveConfig({ dataDir, sampleRoot: SAMPLES });
  const started = await startServer(cfg, undefined);
  try {
    const base = `http://127.0.0.1:${started.port}`;
    const body = new Uint8Array(await import("node:fs/promises").then((fs) => fs.readFile(torrentPath("multi.torrent"))));
    const imp = await fetch(`${base}/api/torrents`, {
      method: "POST",
      body,
      headers: { "content-type": "application/octet-stream", "x-torrent-name": "multi.torrent" },
    });
    assert.equal(imp.status, 201);
    const impJson = (await imp.json()) as { infoHash: string };

    const v = await fetch(`${base}/api/torrents/${impJson.infoHash}/verify`, {
      method: "POST",
      body: JSON.stringify({ rootRel: "multi/good" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(v.status, 200);

    const bad = await fetch(`${base}/api/torrents/${impJson.infoHash}/verify`, {
      method: "POST",
      body: JSON.stringify({ rootRel: "multi/missing" }),
      headers: { "content-type": "application/json" },
    });
    const badJson = (await bad.json()) as { report: { overallStatus: string } };
    assert.equal(badJson.report.overallStatus, "FAIL");

    const notFound = await fetch(`${base}/api/torrents/${"a".repeat(40)}/files`);
    assert.equal(notFound.status, 404);

    const corrupt = await fetch(`${base}/api/torrents`, {
      method: "POST",
      body: new Uint8Array(await import("node:fs/promises").then((fs) => fs.readFile(torrentPath("multi.corrupt.torrent")))),
    });
    assert.equal(corrupt.status, 400);
  } finally {
    await started.close();
  }
});
