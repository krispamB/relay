/** MP4 container sniff. Plan §3.4: the first box is `ftyp` with a sane size. No decode. */

const FTYP = [0x66, 0x74, 0x79, 0x70] as const;

function readU32BE(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset);
}

export function looksLikeMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (bytes[4] !== FTYP[0] || bytes[5] !== FTYP[1] || bytes[6] !== FTYP[2] || bytes[7] !== FTYP[3])
    return false;

  const size = readU32BE(bytes, 0);
  // Size 1 means the real size is a 64-bit largesize. Accept it once those 8 bytes exist.
  if (size === 1) return bytes.length >= 16;
  return size >= 8 && size <= bytes.length;
}
