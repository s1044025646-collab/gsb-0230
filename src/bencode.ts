/**
 * 极简 bencode 实现（BitTorrent v1 所需子集）。
 * - 解码：字符串以 Buffer 表示；字典为普通对象，键为 utf8 字符串，
 *   额外记录每个键值对在原始字节中的起止区间，用于截取 info 的“原始编码字节”。
 * - 编码：输出确定的字节，字典按键的 utf8 字节升序排列（样例种子生成用）。
 */

export type BencValue =
  | Buffer
  | number
  | BencValue[]
  | { [key: string]: BencValue };

export interface DecodedDict {
  value: { [key: string]: BencValue };
  /** 键 -> [起始偏移, 结束偏移)，覆盖该键对应「值」的编码字节（不含键本身） */
  valueSpans: Map<string, [number, number]>;
  /** 键 -> [起始偏移, 结束偏移)，覆盖完整的「键+值」编码字节 */
  kvSpans: Map<string, [number, number]>;
}

export class BencodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BencodeError";
  }
}

class Reader {
  pos = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

 peek(): number {
    return this.buf[this.pos] ?? -1;
  }

 read(): number {
    const b = this.buf[this.pos];
    if (b === undefined) throw new BencodeError("编码提前结束");
    this.pos += 1;
    return b;
  }

 expect(b: number): void {
    const got = this.read();
    if (got !== b) throw new BencodeError(`编码格式错误：期望 0x${b.toString(16)}，实际 0x${got.toString(16)}`);
  }

 decodeValue(): BencValue {
    const c = this.peek();
    if (c === 0x69 /* i */) return this.decodeInt();
    if (c === 0x6c /* l */) return this.decodeList();
    if (c === 0x64 /* d */) return this.decodeDict().value;
    if (c >= 0x30 && c <= 0x39) return this.decodeString();
    throw new BencodeError("非法 bencode 起始字符");
  }

  private decodeInt(): number {
    this.expect(0x69);
    let s = "";
    if (this.peek() === 0x2d /* - */) {
      s += String.fromCharCode(this.read());
    }
    const start = this.pos;
    while (this.peek() !== 0x65 /* e */) {
      const c = this.read();
      if (c < 0x30 || c > 0x39) throw new BencodeError("整数中出现非数字字节");
      s += String.fromCharCode(c);
    }
    if (this.pos === start || (s === "-") || (s.length > 1 && s[0] === "0") || (s.startsWith("-0"))) {
      throw new BencodeError("非法整数（空值、前导零或 -0）");
    }
    this.expect(0x65);
    return Number(s);
  }

  private decodeString(): Buffer {
    let len = "";
    const first = this.read();
    if (first < 0x30 || first > 0x39) throw new BencodeError("字符串长度必须为数字");
    len += String.fromCharCode(first);
    while (this.peek() !== 0x3a /* : */) {
      const c = this.read();
      if (c < 0x30 || c > 0x39) throw new BencodeError("字符串长度必须为数字");
      len += String.fromCharCode(c);
    }
    if (len.length > 1 && len[0] === "0") throw new BencodeError("字符串长度存在前导零");
    this.expect(0x3a);
    const n = Number(len);
    if (this.pos + n > this.buf.length) throw new BencodeError("字符串超出编码末尾");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Buffer.from(out);
  }

  private decodeList(): BencValue[] {
    this.expect(0x6c);
    const list: BencValue[] = [];
    while (this.peek() !== 0x65) {
      if (this.pos >= this.buf.length) throw new BencodeError("列表未闭合");
      list.push(this.decodeValue());
    }
    this.expect(0x65);
    return list;
  }

  decodeDict(): DecodedDict {
    this.expect(0x64);
    const value: { [key: string]: BencValue } = {};
    const valueSpans = new Map<string, [number, number]>();
    const kvSpans = new Map<string, [number, number]>();
    let prevKey: Buffer | null = null;
    while (this.peek() !== 0x65) {
      if (this.pos >= this.buf.length) throw new BencodeError("字典未闭合");
      const kvStart = this.pos;
      const keyBuf = this.decodeString();
      if (prevKey && Buffer.compare(keyBuf, prevKey) <= 0) {
        throw new BencodeError("字典键未按字节序升序排列（编码不合法）");
      }
      prevKey = keyBuf;
      const valueStart = this.pos;
      const v = this.decodeValue();
      const kvEnd = this.pos;
      const key = keyBuf.toString("utf8");
      value[key] = v;
      valueSpans.set(key, [valueStart, kvEnd]);
      kvSpans.set(key, [kvStart, kvEnd]);
    }
    this.expect(0x65);
    return { value, valueSpans, kvSpans };
  }
}

/** 解码整个缓冲区，必须恰好消费全部字节。 */
export function decode(buf: Buffer): BencValue {
  const reader = new Reader(buf);
  const v = reader.decodeValue();
  if (reader.pos !== buf.length) throw new BencodeError("编码末尾存在多余字节");
  return v;
}

/**
 * 解码顶层字典并返回 info 字段的原始编码字节（文件中的实际字节）。
 * 这是计算 v1 info hash 的唯一合法来源。
 */
export function decodeTopWithInfoSpan(buf: Buffer): {
  root: DecodedDict;
  infoSpan: [number, number] | null;
} {
  if (buf[0] !== 0x64) throw new BencodeError("顶层不是 bencode 字典");
  const reader = new Reader(buf);
  const root = reader.decodeDict();
  if (reader.pos !== buf.length) throw new BencodeError("编码末尾存在多余字节");
  const span = root.valueSpans.get("info") ?? null;
  return { root, infoSpan: span };
}

/** bencode 编码（确定性：字典键按 utf8 字节升序）。 */
export function encode(value: BencValue): Buffer {
  const chunks: Buffer[] = [];
  writeValue(value, chunks);
  return Buffer.concat(chunks);
}

function pushText(text: string, out: Buffer[]): void {
  out.push(Buffer.from(text, "latin1"));
}

function writeValue(value: BencValue, out: Buffer[]): void {
  if (Buffer.isBuffer(value)) {
    pushText(`${value.length}:`, out);
    out.push(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new BencodeError("只能编码安全整数");
    pushText(`i${value}e`, out);
    return;
  }
  if (Array.isArray(value)) {
    pushText("l", out);
    for (const item of value) writeValue(item, out);
    pushText("e", out);
    return;
  }
  pushText("d", out);
  const keys = Object.keys(value)
    .map((k) => Buffer.from(k, "utf8"))
    .sort((a, b) => Buffer.compare(a, b));
  for (const key of keys) {
    pushText(`${key.length}:`, out);
    out.push(key);
    writeValue(value[key.toString("utf8")]!, out);
  }
  pushText("e", out);
}
