/**
 * 生成自建模种样例（确定性内容，可重复运行）：
 *
 * samples/
 *   single/             单文件样例目录（good 与 bad-flip）
 *   multi/good/         多文件样例：至少一片横跨两个文件，含空文件与尾片
 *   multi/bad-flip/     翻转一个字节（演示内容不匹配定位）
 *   multi/missing/      删除一个文件（缺文件）
 *   multi/short/        某文件长度变短（长度错误）
 *   torrents/*.torrent  生成的 v1 种子
 *
 * 不依赖外部程序，bencode 与 SHA-1 全部使用项目自身实现/Node 内置算法。
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { encode, type BencValue } from "../src/bencode.ts";

const PIECE_LENGTH = 64 * 1024; // 64 KiB，配合下述尺寸制造跨文件边界与短尾片

const root = resolve(import.meta.dirname, "..", "samples");

/** 确定性伪随机字节（线性同余），保证可重复且不“碰巧”整齐。 */
function seededBytes(seed: number, length: number): Buffer {
  let state = seed >>> 0;
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    buf[i] = (state >>> 16) & 0xff;
  }
  return buf;
}

interface FileSpec {
  parts: string[];
  data: Buffer;
}

function pieceHashes(files: FileSpec[]): Buffer {
  const stream = Buffer.concat(files.map((f) => f.data));
  const hashes: Buffer[] = [];
  for (let off = 0; off < stream.length; off += PIECE_LENGTH) {
    hashes.push(createHash("sha1").update(stream.subarray(off, off + PIECE_LENGTH)).digest());
  }
  return Buffer.concat(hashes);
}

function writeScenario(dir: string, files: FileSpec[]): void {
  for (const f of files) {
    const target = join(dir, ...f.parts);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, f.data);
  }
}

function buildTorrent(name: string, files: FileSpec[], mode: "single" | "multi"): Buffer {
  const info: { [key: string]: BencValue } = {
    name: Buffer.from(name, "utf8"),
    "piece length": PIECE_LENGTH,
    pieces: pieceHashes(files),
  };
  if (mode === "single") {
    info.length = files[0]!.data.length;
  } else {
    info.files = files.map((f) => ({
      length: f.data.length,
      path: f.parts.map((p) => Buffer.from(p, "utf8")),
    }));
  }
  const root: { [key: string]: BencValue } = {
    announce: Buffer.from("http://offline.invalid/announce", "utf8"),
    "created by": Buffer.from("bt-v1-checker sample generator", "utf8"),
    info,
  };
  return encode(root);
}

function cloneFlipByte(files: FileSpec[], fileIdx: number, offset: number): FileSpec[] {
  return files.map((f, i) => {
    if (i !== fileIdx) return { ...f, data: Buffer.from(f.data) };
    const data = Buffer.from(f.data);
    data[offset] = data[offset]! ^ 0xff;
    return { ...f, data };
  });
}

function main(): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "torrents"), { recursive: true });

  // ---- 单文件：100_000 字节 -> 两片，尾片 34_528 字节 ----
  const singleName = "single.bin";
  const singleData = seededBytes(42, 100_000);
  const singleFiles: FileSpec[] = [{ parts: [singleName], data: singleData }];
  writeScenario(join(root, "single", "good"), singleFiles);
  writeScenario(join(root, "single", "bad-flip"), cloneFlipByte(singleFiles, 0, 70_000));
  writeFileSync(
    join(root, "torrents", "single.torrent"),
    buildTorrent(singleName, singleFiles, "single"),
  );

  // ---- 多文件：总长度 200_000，边界 50k/100k 处均在某片内部 ----
  // 分片边界为 0、65536、131072、200000；文件边界 50000、100000、100000(空)、160000。
  // 片0 [0,65536) 横跨 part_a 与 part_b；片1 [65536,131072) 横跨 part_b/空/part_c；
  // 片2 [131072,200000) 为含 part_c/part_d 的尾片（68_928 字节，短于整片）。
  const multiName = "multi-demo";
  const multiFiles: FileSpec[] = [
    { parts: [multiName, "part_a.bin"], data: seededBytes(1, 50_000) },
    { parts: [multiName, "part_b.bin"], data: seededBytes(2, 50_000) },
    { parts: [multiName, "empty.txt"], data: Buffer.alloc(0) },
    { parts: [multiName, "sub", "part_c.bin"], data: seededBytes(3, 60_000) },
    { parts: [multiName, "part_d.bin"], data: seededBytes(4, 40_000) },
  ];
  writeScenario(join(root, "multi", "good"), multiFiles);
  writeFileSync(
    join(root, "torrents", "multi.torrent"),
    buildTorrent(multiName, multiFiles, "multi"),
  );

  // 翻转一个字节：part_b.bin 内偏移 30_000（全局偏移 80_000，落在片1）
  writeScenario(join(root, "multi", "bad-flip"), cloneFlipByte(multiFiles, 1, 30_000));

  // 缺文件：移除 part_c.bin（空文件 empty.txt 保留）
  const missingDir = join(root, "multi", "missing");
  writeScenario(missingDir, multiFiles.filter((_, i) => i !== 3));

  // 长度变化：part_d.bin 截短 123 字节
  const shortFiles = multiFiles.map((f, i) =>
    i === 4 ? { ...f, data: f.data.subarray(0, f.data.length - 123) } : f,
  );
  writeScenario(join(root, "multi", "short"), shortFiles);

  // 损坏元信息种子（截断 bencode），供测试与手动演示
  const multiTorrent = buildTorrent(multiName, multiFiles, "multi");
  writeFileSync(join(root, "torrents", "multi.corrupt.torrent"), multiTorrent.subarray(0, 20));

  // 越界路径种子（路径里含 ..），用于安全校验演示（不写入样例文件）
  const evil = encode({
    info: {
      name: Buffer.from("evil", "utf8"),
      "piece length": PIECE_LENGTH,
      pieces: createHash("sha1").update(Buffer.alloc(0)).digest(),
      files: [
        { length: PIECE_LENGTH - 1, path: [Buffer.from("ok.bin", "utf8")] },
        { length: 1, path: [Buffer.from("..", "utf8"), Buffer.from("escape.bin", "utf8")] },
      ],
    },
  });
  writeFileSync(join(root, "torrents", "evil-traversal.torrent"), evil);

  const manifest = {
    pieceLength: PIECE_LENGTH,
    single: { name: singleName, length: singleData.length, pieces: Math.ceil(singleData.length / PIECE_LENGTH) },
    multi: {
      name: multiName,
      totalLength: multiFiles.reduce((s, f) => s + f.data.length, 0),
      files: multiFiles.map((f) => ({ path: f.parts.join("/"), length: f.data.length })),
    },
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log("样例已生成：", root);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
