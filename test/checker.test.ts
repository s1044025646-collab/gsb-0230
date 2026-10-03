import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync as mkdir, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname as dn, join, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { decode, encode } from '../src/bencode.js';
import { pieceRange } from '../src/torrent.js';
import { Store } from '../src/db.js';
import { CheckerService } from '../src/service.js';
import { parseTorrent } from '../src/torrent.js';
import { safeResolve, verify } from '../src/verifier.js';

const work = mkdtempSync(join(tmpdir(), 'btcheck-'));
const sampleRoot = join(work, 'samples');
const dataDir = join(work, 'data');

const PL = 128;
const a = Buffer.from('A'.repeat(100));
const b = Buffer.concat([Buffer.from('B'.repeat(100)), Buffer.from('0123456789'.repeat(5))]);
const c = Buffer.from('C'.repeat(100));
const empty = Buffer.alloc(0);
const d = Buffer.from('D'.repeat(50));
const stream = Buffer.concat([a, b, c, empty, d]);

function writeFiles(dir: string, files: Record<string, Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel.split('/').join(sep));
    mkdir(dn(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function pieceHashesIndependent(): string[] {
  const out: string[] = [];
  for (let off = 0; off < stream.length; off += PL) {
    out.push(createHash('sha1').update(stream.subarray(off, Math.min(off + PL, stream.length))).digest('hex'));
  }
  return out;
}

function buildMultiTorrent(name: string): Buffer {
  const pieceBin = Buffer.concat(pieceHashesIndependent().map((h) => Buffer.from(h, 'hex')));
  const files = [
    [['a.txt'], 100],
    [['b.bin'], 150],
    [['sub', 'c.log'], 100],
    [['empty.dat'], 0],
    [['d.txt'], 50],
  ] as [string[], number][];
  const list = files.map(([parts, length]) => encode({ length, path: parts }));
  const info = encode({
    files: list.map((x) => decode(x as Buffer)),
    name,
    'piece length': PL,
    pieces: pieceBin,
  });
  return encode({ 'created by': 'test', info: decode(info as Buffer) });
}

function shuffleInfoKeys(buf: Buffer): Buffer {
  const root = decode(buf) as any;
  const info = root.entries.get('info').value;
  const ePieces = info.entries.get('pieces').value as Buffer;
  const nameB = Buffer.from(`${Buffer.byteLength('multi')}:multi`);
  const piecesB = Buffer.concat([Buffer.from(`${ePieces.length}:`), ePieces]);
  const filesB = encode(info.entries.get('files').value);
  const plB = Buffer.from(`i${PL}e`);
  const rebuiltInfo = Buffer.concat([
    Buffer.from('d'),
    Buffer.from('4:name'), nameB,
    Buffer.from('6:pieces'), piecesB,
    Buffer.from('12:piece length'), plB,
    Buffer.from('5:files'), filesB,
    Buffer.from('e'),
  ]);
  const range = root.entries.get('info');
  return Buffer.concat([buf.subarray(0, range.start), rebuiltInfo, buf.subarray(range.end)]);
}

let torrentBuf: Buffer;
let goodDir: string;

before(() => {
  torrentBuf = buildMultiTorrent('multi');
  goodDir = join(sampleRoot, 'multi');
  writeFiles(goodDir, { 'a.txt': a, 'b.bin': b, 'sub/c.log': c, 'empty.dat': empty, 'd.txt': d });
});

after(() => rmSync(work, { recursive: true, force: true }));

test('pieces 长度及与总字节数对应关系', () => {
  const meta = parseTorrent(torrentBuf);
  assert.equal(meta.totalLength, 400);
  assert.equal(meta.pieceCount, 4);
  assert.equal(meta.pieces.length, 80);
});

test('info hash 基于原始 info 编码字节，键序打乱后仍取原始字节', () => {
  const meta = parseTorrent(torrentBuf);
  const decoded = decode(torrentBuf) as any;
  const range = decoded.entries.get('info');
  assert.equal(meta.infoHash, createHash('sha1').update(torrentBuf.subarray(range.start, range.end)).digest('hex'));

  const shuffled = shuffleInfoKeys(torrentBuf);
  const meta2 = parseTorrent(shuffled);
  const decoded2 = decode(shuffled) as any;
  const range2 = decoded2.entries.get('info');
  assert.equal(meta2.infoHash, createHash('sha1').update(shuffled.subarray(range2.start, range2.end)).digest('hex'));
});

test('跨文件边界 / 空文件 / 尾片：独立拼接的预期哈希逐片一致', () => {
  const meta = parseTorrent(torrentBuf);
  const expected = pieceHashesIndependent();
  const r0 = pieceRange(meta, 0);
  const r1 = pieceRange(meta, 1);
  const r2 = pieceRange(meta, 2);
  const r3 = pieceRange(meta, 3);
  assert.deepEqual(r0.files.map((x) => x.path), ['a.txt', 'b.bin']);
  assert.deepEqual(r1.files.map((x) => x.path), ['b.bin', 'sub/c.log']);
  assert.deepEqual(r2.files.map((x) => x.path), ['sub/c.log', 'empty.dat', 'd.txt']);
  assert.equal(r3.length, 16);

  const report = verify(meta, goodDir);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.pieces.map((p) => p.actualSha1), expected);
});

test('总长 0 的空文件种子：0 片且通过', () => {
  const info = encode({ length: 0, name: 'zero.bin', 'piece length': PL, pieces: Buffer.alloc(0) });
  const t = encode({ info: decode(info as Buffer) });
  const dir = join(sampleRoot, 'zero');
  writeFiles(dir, { 'zero.bin': Buffer.alloc(0) });
  const report = verify(parseTorrent(t as Buffer), dir);
  assert.equal(report.pieceCount, 0);
  assert.equal(report.status, 'pass');
});

test('翻转一个字节：仅分片 #1 内容不匹配，可定位文件', () => {
  const dir = join(sampleRoot, 'bad');
  const bbad = Buffer.from(b);
  bbad[50] ^= 0xff;
  writeFiles(dir, { 'a.txt': a, 'b.bin': bbad, 'sub/c.log': c, 'empty.dat': empty, 'd.txt': d });
  const report = verify(parseTorrent(torrentBuf), dir);
  assert.equal(report.status, 'fail');
  assert.equal(report.okCount, 3);
  assert.equal(report.badCount, 1);
  assert.equal(report.pieces[1].status, 'mismatch');
  assert.deepEqual(report.pieces[1].files.map((x) => x.path), ['b.bin', 'sub/c.log']);
});

test('缺文件：unreadable 且其余分片不被当作全部通过', () => {
  const dir = join(sampleRoot, 'missing');
  writeFiles(dir, { 'a.txt': a, 'sub/c.log': c, 'empty.dat': empty, 'd.txt': d });
  const report = verify(parseTorrent(torrentBuf), dir);
  assert.equal(report.status, 'fail');
  assert.equal(report.files.find((x) => x.path === 'b.bin')!.status, 'missing');
  assert.ok(report.unreadableCount >= 1);
  assert.equal(report.okCount + report.badCount + report.unreadableCount, 4);
  assert.ok(report.pieces.some((p) => p.status === 'unreadable' && p.reasons.some((r) => r.includes('文件缺失'))));
});

test('长度变化：length_mismatch 且整体不通过', () => {
  const dir = join(sampleRoot, 'lengthchange');
  writeFiles(dir, { 'a.txt': a, 'b.bin': Buffer.concat([b, Buffer.from('X')]), 'sub/c.log': c, 'empty.dat': empty, 'd.txt': d });
  const report = verify(parseTorrent(torrentBuf), dir);
  assert.equal(report.files.find((x) => x.path === 'b.bin')!.status, 'length_mismatch');
  assert.equal(report.status, 'fail');
});

test('损坏元信息：明确错误码', () => {
  assert.throws(() => parseTorrent(Buffer.concat([torrentBuf, Buffer.from('XXXX')])), (e: any) => e.code === 'META_BENCODE_CORRUPT');
  const info1 = encode({ length: 10, name: 'x', 'piece length': 16, pieces: Buffer.alloc(15) });
  assert.throws(() => parseTorrent(encode({ info: decode(info1 as Buffer) }) as Buffer), (e: any) => e.code === 'META_PIECES_LENGTH');
  const info2 = encode({ length: 100, name: 'x', 'piece length': 16, pieces: Buffer.alloc(40) });
  assert.throws(() => parseTorrent(encode({ info: decode(info2 as Buffer) }) as Buffer), (e: any) => e.code === 'META_PIECES_MISMATCH');
  const v2 = encode({ info: decode(encode({ length: 16, name: 'x', 'piece length': 16, pieces: Buffer.alloc(20), 'meta version': 2 }) as Buffer) });
  assert.throws(() => parseTorrent(v2 as Buffer), (e: any) => e.code === 'META_V2_UNSUPPORTED');
});

test('路径越界被拒绝', () => {
  assert.throws(() => safeResolve(sampleRoot, '../escape.txt'), (e: any) => e.code === 'PATH_TRAVERSAL');
  assert.throws(
    () => parseTorrent(encode({ info: decode(encode({ length: 1, name: '../evil', 'piece length': 16, pieces: Buffer.alloc(20) }) as Buffer) }) as Buffer),
    (e: any) => e.code === 'META_INVALID_PATH',
  );
});

test('重启后可查询旧报告，且源文件未被改动', () => {
  const torrentPath = join(work, 'multi.torrent');
  writeFileSync(torrentPath, torrentBuf);
  const torrentBefore = readFileSync(torrentPath);
  const sampleBefore = readFileSync(join(goodDir, 'b.bin'));

  let store = new Store(join(dataDir, 'checker.sqlite'));
  let svc = new CheckerService(store);
  const { torrentId } = svc.importTorrent(torrentPath);
  const { reportId } = svc.runVerify(String(torrentId), 'multi', sampleRoot);
  store.close();

  store = new Store(join(dataDir, 'checker.sqlite'));
  svc = new CheckerService(store);
  assert.ok(svc.listReports().some((r) => r.id === reportId && r.status === 'pass'));
  assert.equal(svc.getReport(reportId).pieceCount, 4);
  store.close();

  assert.ok(readFileSync(torrentPath).equals(torrentBefore));
  assert.ok(readFileSync(join(goodDir, 'b.bin')).equals(sampleBefore));
});

test('导出 JSON 与持久化内容一致', () => {
  const out = join(work, 'export.json');
  const store = new Store(join(dataDir, 'checker.sqlite'));
  const svc = new CheckerService(store);
  const first = svc.listReports()[0];
  svc.exportReport(first.id, out);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).pieceCount, 4);
  store.close();
});
