import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTorrent, filesOverlapping, pieceByteRange } from "../src/torrent.ts";
import { verifyTorrent } from "../src/verifier.ts";
import { encode } from "../src/bencode.ts";
import { AppError } from "../src/errors.js";
import { SAMPLES, snapshotDir } from "./helpers.ts";

function loadMulti(): ReturnType<typeof parseTorrent> {
  return parseTorrent(readFileSync(join(SAMPLES, "torrents", "multi.torrent")), join(SAMPLES, "multi", "good"));
}

function loadSingle(root: string): ReturnType<typeof parseTorrent> {
  return parseTorrent(readFileSync(join(SAMPLES, "torrents", "single.torrent")), root);
}

test("跨文件边界：分片按连续字节流拼接，与独立拼接的预期字节一致", () => {
  const meta = loadMulti();
  assert.equal(meta.totalLength, 200_000);
  assert.equal(meta.pieceLength, 65_536);
  assert.equal(meta.expectedPieceCount, 4);

  // 独立把文件按顺序拼接，逐片独立计算，再和 pieces 字段核对
  const stream = Buffer.concat(
    meta.files.map((f) => readFileSync(f.absPath)),
  );
  for (let i = 0; i < meta.expectedPieceCount; i += 1) {
    const [s, e] = [i * meta.pieceLength, Math.min((i + 1) * meta.pieceLength, meta.totalLength)];
    const expectHash = createHash("sha1").update(stream.subarray(s, e)).digest();
    assert.ok(meta.pieceHashes[i]!.equals(expectHash), `片 ${i} 的 pieces 字段与独立拼接结果不符`);
  }

  // 片0 横跨 part_a/part_b；片1 横跨 part_b/empty/part_c
  assert.deepEqual(filesOverlapping(meta, ...pieceByteRange(meta, 0)).map((f) => f.relPath), [
    "multi-demo/part_a.bin",
    "multi-demo/part_b.bin",
  ]);
  assert.deepEqual(filesOverlapping(meta, ...pieceByteRange(meta, 1)).map((f) => f.relPath), [
    "multi-demo/part_b.bin",
    "multi-demo/empty.txt",
    "multi-demo/sub/part_c.bin",
  ]);
});

test("尾片长度不足整片（3392 字节）且空文件存在", () => {
  const meta = loadMulti();
  const [s, e] = pieceByteRange(meta, 3);
  assert.equal(e - s, 3_392);
  const empty = meta.files.find((f) => f.relPath === "multi-demo/empty.txt")!;
  assert.equal(empty.length, 0);
});

test("good 场景全部通过，包含空文件", async () => {
  const report = await verifyTorrent(loadMulti());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.failedCount, 0);
  const emptyFile = report.files.find((f) => f.relPath === "multi-demo/empty.txt")!;
  assert.equal(emptyFile.exists, true);
  assert.equal(emptyFile.status, "OK");
});

test("单文件尾片与翻转字节定位", async () => {
  const good = await verifyTorrent(loadSingle(join(SAMPLES, "single", "good")));
  assert.equal(good.overallStatus, "PASS");
  assert.equal(good.pieces[1]!.expectedLength, 34_464);

  const bad = await verifyTorrent(loadSingle(join(SAMPLES, "single", "bad-flip")));
  assert.equal(bad.overallStatus, "FAIL");
  assert.equal(bad.failedCount, 1);
  assert.equal(bad.pieces[1]!.status, "CONTENT_MISMATCH");
  assert.equal(bad.pieces[0]!.status, "OK");
});

test("多文件翻转一个字节：只有片1 CONTENT_MISMATCH，且给出涉及文件", async () => {
  const meta = parseTorrent(readFileSync(join(SAMPLES, "torrents", "multi.torrent")), join(SAMPLES, "multi", "bad-flip"));
  const report = await verifyTorrent(meta);
  const failed = report.pieces.filter((p) => p.status !== "OK");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.index, 1);
  assert.equal(failed[0]!.status, "CONTENT_MISMATCH");
  assert.deepEqual(failed[0]!.files, [
    "multi-demo/part_b.bin",
    "multi-demo/empty.txt",
    "multi-demo/sub/part_c.bin",
  ]);
});

test("缺文件：标记 FILE_MISSING，其余片照常核对，不会被当作全部通过", async () => {
  const meta = parseTorrent(readFileSync(join(SAMPLES, "torrents", "multi.torrent")), join(SAMPLES, "multi", "missing"));
  const report = await verifyTorrent(meta);
  assert.equal(report.overallStatus, "FAIL");
  const statuses = report.pieces.map((p) => p.status);
  assert.deepEqual(statuses, ["OK", "FILE_MISSING", "FILE_MISSING", "OK"]);
  const missingFile = report.files.find((f) => f.relPath === "multi-demo/sub/part_c.bin")!;
  assert.equal(missingFile.exists, false);
  assert.equal(missingFile.status, "MISSING");
});

test("长度变化：短文件相关片为 LENGTH_MISMATCH，未受影响片仍 OK", async () => {
  const meta = parseTorrent(readFileSync(join(SAMPLES, "torrents", "multi.torrent")), join(SAMPLES, "multi", "short"));
  const report = await verifyTorrent(meta);
  assert.equal(report.overallStatus, "FAIL");
  assert.deepEqual(report.pieces.map((p) => p.status), ["OK", "OK", "LENGTH_MISMATCH", "LENGTH_MISMATCH"]);
});

test("元信息损坏：截断的种子抛 METADATA_CORRUPT", () => {
  assert.throws(
    () => parseTorrent(readFileSync(join(SAMPLES, "torrents", "multi.corrupt.torrent")), SAMPLES),
    (err: unknown) => err instanceof AppError && err.code === "METADATA_CORRUPT",
  );
});

test("元信息损坏：pieces 长度与总字节不匹配", () => {
  const good = encode({
    info: {
      name: Buffer.from("x"),
      "piece length": 65_536,
      pieces: Buffer.alloc(40),
      length: 65_536 * 3,
    },
  });
  assert.throws(() => parseTorrent(good, SAMPLES), (err: unknown) => err instanceof AppError && err.code === "METADATA_CORRUPT");
});

test("拒绝 v2 / 混合种子", () => {
  const v2 = encode({
    info: {
      name: Buffer.from("x"),
      "piece length": 65_536,
      meta_version: 2,
      pieces: Buffer.alloc(0),
      length: 0,
    },
  });
  assert.throws(() => parseTorrent(v2, SAMPLES), (err: unknown) => err instanceof AppError && err.code === "UNSUPPORTED_FORMAT");
});

test("路径越界：.. 逃逸被拒绝（PATH_TRAVERSAL）", () => {
  assert.throws(
    () => parseTorrent(readFileSync(join(SAMPLES, "torrents", "evil-traversal.torrent")), SAMPLES),
    (err: unknown) => err instanceof AppError && err.code === "PATH_TRAVERSAL",
  );
});

test("校验过程不修改任何源文件", async () => {
  const roots = [join(SAMPLES, "multi", "good"), join(SAMPLES, "multi", "bad-flip"), join(SAMPLES, "multi", "missing"), join(SAMPLES, "multi", "short"), join(SAMPLES, "single")];
  const before = roots.map((r) => snapshotDir(r));
  await verifyTorrent(loadMulti());
  await verifyTorrent(parseTorrent(readFileSync(join(SAMPLES, "torrents", "multi.torrent")), join(SAMPLES, "multi", "bad-flip")));
  await verifyTorrent(parseTorrent(readFileSync(join(SAMPLES, "torrents", "multi.torrent")), join(SAMPLES, "multi", "missing")));
  await verifyTorrent(parseTorrent(readFileSync(join(SAMPLES, "torrents", "multi.torrent")), join(SAMPLES, "multi", "short")));
  const after = roots.map((r) => snapshotDir(r));
  assert.deepEqual(after, before);
});
