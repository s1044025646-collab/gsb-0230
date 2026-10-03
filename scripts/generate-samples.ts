import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMultiTorrent, makeSingleTorrent, toAbs, writeTorrent } from './make-torrent.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const samplesDir = resolve(root, 'samples');
const torrentsDir = resolve(root, 'torrents');
mkdirSync(torrentsDir, { recursive: true });

function write(rel: string, content: Buffer | string): void {
  const abs = toAbs(samplesDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// ---------- 多文件样例（pieceLength=128，总 400 字节，4 片，含空文件） ----------
// 布局：a.txt=100  b.bin=150  sub/c.log=100  empty.dat=0  d.txt=50
// 全局偏移：a[0,100) b[100,250) c[250,350) empty[350,350) d[350,400)
// 分片：#0[0,128) 横跨 a 全部 + b 前 28 字节（跨文件边界）
//      #1[128,256) 横跨 b 余 122 + c 前 6
//      #2[256,384) 横跨 c 余 94 + 空文件 + d 前 34
//      #3[384,400) 尾片 16 字节（d 内）
const a = Buffer.from('A'.repeat(100), 'ascii');
const b = Buffer.concat([Buffer.from('B'.repeat(100)), Buffer.from('0123456789'.repeat(5))]); // 150
const c = Buffer.from('C'.repeat(100), 'ascii');
const empty = Buffer.alloc(0);
const d = Buffer.from('D'.repeat(50), 'ascii');

const multiName = 'multi-good';
write(`${multiName}/a.txt`, a);
write(`${multiName}/b.bin`, b);
write(`${multiName}/sub/c.log`, c);
write(`${multiName}/empty.dat`, empty);
write(`${multiName}/d.txt`, d);

const multiFiles = [
  { pathParts: ['a.txt'], abs: toAbs(samplesDir, `${multiName}/a.txt`), length: 100 },
  { pathParts: ['b.bin'], abs: toAbs(samplesDir, `${multiName}/b.bin`), length: 150 },
  { pathParts: ['sub', 'c.log'], abs: toAbs(samplesDir, `${multiName}/sub/c.log`), length: 100 },
  { pathParts: ['empty.dat'], abs: toAbs(samplesDir, `${multiName}/empty.dat`), length: 0 },
  { pathParts: ['d.txt'], abs: toAbs(samplesDir, `${multiName}/d.txt`), length: 50 },
];
writeTorrent(
  resolve(torrentsDir, 'multi-good.torrent'),
  makeMultiTorrent({ name: multiName, files: multiFiles, pieceLength: 128 }),
);

// 损坏副本：复制 good，再在 b.bin 全局偏移 150（b 内偏移 50）翻转 1 字节 -> 落在分片 #1
const badName = 'multi-bad';
for (const [rel, content] of [
  [`${badName}/a.txt`, a],
  [`${badName}/b.bin`, b],
  [`${badName}/sub/c.log`, c],
  [`${badName}/empty.dat`, empty],
  [`${badName}/d.txt`, d],
] as [string, Buffer][]) {
  write(rel, content);
}
{
  const badB = readFileSync(toAbs(samplesDir, `${badName}/b.bin`));
  badB[50] = badB[50] ^ 0xff; // 翻转一个字节（B -> 其他）
  writeFileSync(toAbs(samplesDir, `${badName}/b.bin`), badB);
}
writeTorrent(
  resolve(torrentsDir, 'multi-bad.torrent'),
  makeMultiTorrent({
    name: badName,
    files: multiFiles.map((f) => ({ ...f, abs: f.abs.replace(multiName, badName) })),
    pieceLength: 128,
  }),
);
// multi-bad 元信息以“正确字节”生成，但校验目录是被改过字节的副本 => #1 不匹配

// ---------- 单文件样例（300 字节，pieceLength=128 -> 3 片，尾片 44） ----------
const singleName = 'single-good';
const singleContent = Buffer.from('S'.repeat(300), 'ascii');
write(`${singleName}/payload.bin`, singleContent);
writeTorrent(
  resolve(torrentsDir, 'single-good.torrent'),
  makeSingleTorrent({
    name: 'payload.bin',
    fileAbs: toAbs(samplesDir, `${singleName}/payload.bin`),
    length: 300,
    pieceLength: 128,
  }),
);

// 损坏元信息样例：在 multi-good.torrent 末尾追加垃圾字节
const corrupted = Buffer.concat([readFileSync(resolve(torrentsDir, 'multi-good.torrent')), Buffer.from('XXXX')]);
writeFileSync(resolve(torrentsDir, 'corrupted.torrent'), corrupted);

console.log('样例生成完成:');
console.log('  samples/multi-good   (多文件, 含跨文件分片与空文件)');
console.log('  samples/multi-bad    (b.bin 翻转 1 字节 -> 分片 #1 失败)');
console.log('  samples/single-good  (单文件, 尾片不足整长)');
console.log('  torrents/*.torrent   (含 corrupted.torrent 元信息损坏样例)');
