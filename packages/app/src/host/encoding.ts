// UTF-8 and base64 without Buffer/TextEncoder, so the host service runs unchanged in Hermes.

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else code = 0xfffd;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }
  return Uint8Array.from(out);
}

export function utf8ByteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** Sequence length announced by a lead byte; 1 for ASCII and for bytes that cannot lead. */
function leadLength(b: number): number {
  if (b >= 0xc2 && b < 0xe0) return 2;
  if (b >= 0xe0 && b < 0xf0) return 3;
  if (b >= 0xf0 && b < 0xf5) return 4;
  return 1;
}

/** Payload bits of a lead byte and the smallest code point (no overlongs), by sequence length. */
const LEAD_MASK = [0, 0, 0x1f, 0x0f, 0x07];
const MIN_CODE = [0, 0, 0x80, 0x800, 0x10000];

/** The code point of the `len`-byte sequence at `i`, or -1 when it is truncated or invalid. */
function decodeSequence(bytes: Uint8Array, i: number, len: number, end: number): number {
  if (i + len > end) return -1;
  let code = bytes[i]! & LEAD_MASK[len]!;
  for (let k = 1; k < len; k++) {
    const c = bytes[i + k]!;
    if ((c & 0xc0) !== 0x80) return -1;
    code = (code << 6) | (c & 63);
  }
  if (code < MIN_CODE[len]! || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return -1;
  return code;
}

/** Lenient decoder: invalid or truncated sequences become U+FFFD. */
export function utf8Decode(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = "";
  const chunk: number[] = [];
  const flush = () => {
    out += String.fromCharCode(...chunk);
    chunk.length = 0;
  };
  let i = start;
  while (i < end) {
    const b = bytes[i]!;
    let code = b < 0x80 ? b : 0xfffd;
    let len = leadLength(b);
    if (len > 1) {
      const decoded = decodeSequence(bytes, i, len, end);
      if (decoded < 0) len = 1;
      else code = decoded;
    }
    if (code >= 0x10000) {
      const v = code - 0x10000;
      chunk.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else chunk.push(code);
    if (chunk.length >= 8192) flush();
    i += len;
  }
  flush();
  return out;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62;
  t["_".charCodeAt(0)] = 63;
  return t;
})();

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[n >> 18]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + "=";
  }
  return out;
}

/** Ignores whitespace (GNU base64 wraps at 76 columns) and stops at padding. */
export function base64Decode(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 61) break; // '='
    const v = c < 256 ? LOOKUP[c]! : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

export function base64EncodeText(text: string): string {
  return base64Encode(utf8Encode(text));
}
