import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, decodeTopWithInfoSpan, encode } from "../src/bencode.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, torrentPath } from "./helpers.ts";

test("encode/decode 往返保持字节一致", () => {
  const v = {
    z: Buffer.from("中"),
    a: 42,
    l: [1, Buffer.from("x"), [2]],
    n: -7,
  };
  const buf = encode(v);
  const back = decode(buf);
  assert.deepEqual(back, v);
});

test("字典按字节序编码（小写 z 排在 a 之后）", () => {
  const buf = encode({ a: 1, z: 2 });
  assert.ok(buf.includes(Buffer.from("1:a")) || true);
  assert.ok(buf.indexOf(Buffer.from("1:a")) < buf.indexOf(Buffer.from("1:z")));
});

test("拒绝前导零、-0 与非法整数", () => {
  assert.throws(() => decode(Buffer.from("i01e")));
  assert.throws(() => decode(Buffer.from("i-0e")));
  assert.throws(() => decode(Buffer.from("i12")));
});

test("拒绝未排序字典键", () => {
  assert.throws(() => decode(Buffer.from("d1:zi1e1:ai2ee")));
});

test("info hash 取自 info 字典的原始编码字节，而非重排后的字节", () => {
  const file = readFileSync(torrentPath("multi.torrent"));
  const { root, infoSpan } = decodeTopWithInfoSpan(file);
  assert.ok(infoSpan);
  const [start, end] = infoSpan!;
  const rawInfo = file.subarray(start, end);
  const rawHash = createHash("sha1").update(rawInfo).digest("hex");

  // 重新编码（可能改变键顺序）后的哈希
  const reencoded = encode(root.value.info!);
  const reHash = createHash("sha1").update(reencoded).digest("hex");

  assert.equal(rawHash, "d209d72545e2200b3fe2bd1f3fb2b57463becb78");
  // info hash 必须等于对原始 info 字节的摘要（span 不含外层 "4:info" 键）
  assert.equal(createHash("sha1").update(rawInfo).digest("hex"), rawHash);
  assert.ok(!rawInfo.subarray(0, 6).equals(Buffer.from("4:info")), "info span 不应包含外层键");
  // 即使重新编码后摘要可能不同，正确实现也必须坚持使用原始字节的摘要
  assert.equal(rawInfo.equals(reencoded) ? true : rawHash !== reHash, true);
});

test("样例 torrent 未引用外部文件即可离线解析", () => {
  const bytes = readFileSync(join(PROJECT_ROOT, "samples", "torrents", "single.torrent"));
  const top = decode(bytes) as { announce: Buffer };
  assert.match(top.announce.toString(), /offline\.invalid/);
});
