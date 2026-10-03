/**
 * 最小化 bencode 解码器。
 * 关键点：解码字典时记录每个值在原始缓冲区中的字节区间，
 * 以便直接对 info 字典的“原始编码字节”计算 SHA-1（info hash），
 * 而不是重新序列化（重排键序）后再摘要。
 */

export type BValue = number | Buffer | BValue[] | BDict;
export interface BDict {
  entries: Map<string, BEntry>;
}
export interface BEntry {
  value: BValue;
  /** 该值在原始缓冲区中的起止偏移（不含 key） */
  start: number;
  end: number;
}

export class BencodeError extends Error {
  code = 'BENCODE_ERROR';
}

export class Decoder {
  constructor(private buf: Buffer, private pos = 0) {}

  static decode(buf: Buffer): { value: BValue; end: number } {
    const d = new Decoder(buf, 0);
    const value = d.readValue();
    if (d.pos !== buf.length) {
      throw new BencodeError(`bencode 解码后存在多余字节（位置 ${d.pos} / ${buf.length}）`);
    }
    return { value, end: d.pos };
  }

  private readValue(): BValue {
    const c = this.buf[this.pos];
    if (c === undefined) throw new BencodeError('意外的缓冲区结尾');
    if (c === 0x69 /* i */) return this.readInt();
    if (c === 0x6c /* l */) return this.readList();
    if (c === 0x64 /* d */) return this.readDict();
    if (c >= 0x30 && c <= 0x39) return this.readString();
    throw new BencodeError(`位置 ${this.pos} 处出现非法 bencode 标记 0x${c.toString(16)}`);
  }

  private readInt(): number {
    this.pos++; // skip 'i'
    const end = this.buf.indexOf(0x65 /* e */, this.pos);
    if (end === -1) throw new BencodeError('整数缺少结束符 e');
    const text = this.buf.toString('ascii', this.pos, end);
    if (!/^-?\d+$/.test(text) || text === '-0' || (text.length > 1 && text.startsWith('0'))) {
      throw new BencodeError(`非法整数编码: ${text}`);
    }
    this.pos = end + 1;
    return Number(text);
  }

  private readString(): Buffer {
    const colon = this.buf.indexOf(0x3a /* : */, this.pos);
    if (colon === -1) throw new BencodeError('字符串缺少冒号');
    const lenText = this.buf.toString('ascii', this.pos, colon);
    if (!/^\d+$/.test(lenText) || (lenText.length > 1 && lenText.startsWith('0'))) {
      throw new BencodeError(`非法字符串长度: ${lenText}`);
    }
    const len = Number(lenText);
    const start = colon + 1;
    const end = start + len;
    if (end > this.buf.length) throw new BencodeError(`字符串长度 ${len} 超出缓冲区`);
    this.pos = end;
    return this.buf.subarray(start, end);
  }

  private readList(): BValue[] {
    this.pos++; // skip 'l'
    const list: BValue[] = [];
    while (this.buf[this.pos] !== 0x65) {
      if (this.pos >= this.buf.length) throw new BencodeError('列表缺少结束符 e');
      list.push(this.readValue());
    }
    this.pos++; // skip 'e'
    return list;
  }

  private readDict(): BDict {
    this.pos++; // skip 'd'
    const entries = new Map<string, BEntry>();
    while (this.buf[this.pos] !== 0x65) {
      if (this.pos >= this.buf.length) throw new BencodeError('字典缺少结束符 e');
      const keyBuf = this.readString();
      const key = keyBuf.toString('utf8');
      const start = this.pos;
      const value = this.readValue();
      entries.set(key, { value, start, end: this.pos });
    }
    this.pos++; // skip 'e'
    return { entries };
  }
}

export function decode(buf: Buffer): BValue {
  return Decoder.decode(buf).value;
}

export function isDict(v: BValue | undefined): v is BDict {
  return !!v && typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v) && v instanceof Object && 'entries' in v;
}

export function asDict(v: BValue | undefined): BDict {
  if (!isDict(v)) throw new BencodeError('期望字典类型');
  return v;
}

export function asBuf(v: BValue | undefined): Buffer {
  if (!Buffer.isBuffer(v)) throw new BencodeError('期望字节串类型');
  return v;
}

export function asInt(v: BValue | undefined): number {
  if (typeof v !== 'number') throw new BencodeError('期望整数类型');
  return v;
}

export function asList(v: BValue | undefined): BValue[] {
  if (!Array.isArray(v)) throw new BencodeError('期望列表类型');
  return v;
}

/** 稳定编码（仅用于测试辅助/重新生成种子场景） */
export function encode(v: BValue | string | number | Buffer | unknown[] | { [k: string]: unknown }): Buffer {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  }
  if (Array.isArray(v)) {
    return Buffer.concat([Buffer.from('l'), ...v.map((x) => encode(x as BValue)), Buffer.from('e')]);
  }
  if (v && typeof v === 'object') {
    if ('entries' in (v as object)) {
      const d = v as BDict;
      const parts: Buffer[] = [Buffer.from('d')];
      for (const [k, e] of [...d.entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        parts.push(encode(k), encode(e.value as BValue));
      }
      parts.push(Buffer.from('e'));
      return Buffer.concat(parts);
    }
    const obj = v as Record<string, unknown>;
    const parts: Buffer[] = [Buffer.from('d')];
    for (const k of Object.keys(obj).sort()) parts.push(encode(k), encode(obj[k] as BValue));
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
  }
  throw new BencodeError('无法编码的值');
}
