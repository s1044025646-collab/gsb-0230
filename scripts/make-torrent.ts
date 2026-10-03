import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

function bstr(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from(`${b.length}:`), b]);
}
function bint(n: number): Buffer {
  return Buffer.from(`i${n}e`);
}

function dict(entries: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [Buffer.from('d')];
  for (const [k, v] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) parts.push(bstr(k), v);
  parts.push(Buffer.from('e'));
  return Buffer.concat(parts) as Buffer;
}

/** 按连续字节流切片计算 pieces（与校验端语义一致） */
export function computePieces(files: { abs: string }[], pieceLength: number): Buffer {
  const hashes: Buffer[] = [];
  let hash = createHash('sha1');
  let inPiece = 0;
  for (const f of files) {
    const data = readFileSync(f.abs);
    let off = 0;
    while (off < data.length) {
      const need = pieceLength - inPiece;
      const take = Math.min(need, data.length - off);
      hash.update(data.subarray(off, off + take));
      off += take;
      inPiece += take;
      if (inPiece === pieceLength) {
        hashes.push(hash.digest());
        hash = createHash('sha1');
        inPiece = 0;
      }
    }
  }
  if (inPiece > 0) hashes.push(hash.digest());
  return Buffer.concat(hashes);
}

export function makeSingleTorrent(opts: { name: string; fileAbs: string; length: number; pieceLength: number }): Buffer {
  const pieces = computePieces([{ abs: opts.fileAbs }], opts.pieceLength);
  const info = dict([
    ['length', bint(opts.length)],
    ['name', bstr(opts.name)],
    ['piece length', bint(opts.pieceLength)],
    ['pieces', Buffer.concat([Buffer.from(`${pieces.length}:`), pieces])],
    ['private', bint(1)],
  ]);
  return dict([
    ['announce', bstr('http://offline.invalid/announce')],
    ['created by', bstr('bt-meta-checker sample generator')],
    ['info', info],
  ]);
}

export function makeMultiTorrent(opts: {
  name: string;
  files: { pathParts: string[]; abs: string; length: number }[];
  pieceLength: number;
}): Buffer {
  const pieces = computePieces(opts.files, opts.pieceLength);
  const fileList = opts.files.map((f) =>
    dict([
      ['length', bint(f.length)],
      ['path', Buffer.concat([Buffer.from('l'), ...f.pathParts.map((p) => bstr(p)), Buffer.from('e')])],
    ]),
  );
  const info = dict([
    ['files', Buffer.concat([Buffer.from('l'), ...fileList, Buffer.from('e')])],
    ['name', bstr(opts.name)],
    ['piece length', bint(opts.pieceLength)],
    ['pieces', Buffer.concat([Buffer.from(`${pieces.length}:`), pieces])],
  ]);
  return dict([
    ['announce', bstr('http://offline.invalid/announce')],
    ['created by', bstr('bt-meta-checker sample generator')],
    ['info', info],
  ]);
}

export function writeTorrent(path: string, buf: Buffer): void {
  writeFileSync(path, buf);
}

export function toAbs(root: string, rel: string): string {
  return resolve(root, rel.split('/').join(sep));
}

