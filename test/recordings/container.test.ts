import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { looksLikeMp4 } from '../../src/recordings/container.js';

/** A 16-byte `ftyp` box whose major brand is `M4A `. */
function m4aFtyp(size = 16): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 16));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  bytes.set([0x4d, 0x34, 0x41, 0x20], 8); // M4A
  return bytes;
}

describe('looksLikeMp4', () => {
  it('accepts a minimal ftyp box branded M4A', () => {
    expect(looksLikeMp4(m4aFtyp())).toBe(true);
  });

  it('rejects random bytes, a short buffer and a box that is not ftyp', () => {
    const random = randomBytes(32);
    random[4] = 0x00;
    expect(looksLikeMp4(random)).toBe(false);
    expect(looksLikeMp4(m4aFtyp().subarray(0, 11))).toBe(false);
    expect(looksLikeMp4(new Uint8Array(0))).toBe(false);

    const moov = m4aFtyp();
    moov.set([0x6d, 0x6f, 0x6f, 0x76], 4); // moov
    expect(looksLikeMp4(moov)).toBe(false);
  });

  it('rejects a size below 8 or past the buffer, and allows the 64-bit largesize sentinel', () => {
    const tooSmall = m4aFtyp(7);
    expect(looksLikeMp4(tooSmall)).toBe(false);

    const overruns = m4aFtyp();
    new DataView(overruns.buffer).setUint32(0, 24);
    expect(looksLikeMp4(overruns)).toBe(false);

    const largesize = new Uint8Array(16);
    new DataView(largesize.buffer).setUint32(0, 1);
    largesize.set([0x66, 0x74, 0x79, 0x70], 4);
    expect(looksLikeMp4(largesize)).toBe(true);
    expect(looksLikeMp4(largesize.subarray(0, 12))).toBe(false);
  });
});
