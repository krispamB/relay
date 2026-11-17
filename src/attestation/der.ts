/**
 * Minimal, strict DER reader: just enough to pull one extension out of an X.509 certificate.
 * Node's X509Certificate does not expose arbitrary extensions. Every malformed input throws.
 */

interface Tlv {
  tag: number;
  /** Offset of the first content byte. */
  start: number;
  /** Offset one past the last content byte. */
  end: number;
}

function readTlv(buf: Buffer, offset: number, limit: number): Tlv {
  if (offset + 2 > limit) throw new Error('der: truncated header');
  const tag = buf[offset] as number;
  if ((tag & 0x1f) === 0x1f) throw new Error('der: multi-byte tags unsupported');
  let len = buf[offset + 1] as number;
  let pos = offset + 2;
  if (len === 0x80) throw new Error('der: indefinite length');
  if (len > 0x80) {
    const n = len & 0x7f;
    if (n > 4 || pos + n > limit) throw new Error('der: bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (buf[pos + i] as number);
    pos += n;
  }
  const end = pos + len;
  if (end > limit) throw new Error('der: content overruns parent');
  return { tag, start: pos, end };
}

function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = parent.start;
  while (pos < parent.end) {
    const t = readTlv(buf, pos, parent.end);
    out.push(t);
    pos = t.end;
  }
  return out;
}

function decodeOid(bytes: Buffer): string {
  if (bytes.length === 0) throw new Error('der: empty oid');
  const parts: number[] = [];
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    value = value * 128 + (b & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER / 128) throw new Error('der: oid arc too large');
    if ((b & 0x80) === 0) {
      if (parts.length === 0) {
        const first = value < 80 ? Math.floor(value / 40) : 2;
        parts.push(first, value - first * 40);
      } else {
        parts.push(value);
      }
      value = 0;
    } else if (i === bytes.length - 1) {
      throw new Error('der: truncated oid');
    }
  }
  return parts.join('.');
}

const SEQUENCE = 0x30;
const OID = 0x06;
const BOOLEAN = 0x01;
const OCTET_STRING = 0x04;
const EXTENSIONS_TAG = 0xa3; // [3] EXPLICIT in TBSCertificate

/**
 * Returns the extnValue contents (the bytes inside the OCTET STRING) of the extension with this OID,
 * or undefined if the certificate does not carry it. Throws on malformed DER or a duplicated extension.
 */
export function getCertificateExtension(certDer: Buffer, oid: string): Buffer | undefined {
  const cert = readTlv(certDer, 0, certDer.length);
  if (cert.tag !== SEQUENCE || cert.end !== certDer.length) throw new Error('der: not a certificate');
  const tbs = children(certDer, cert)[0];
  if (!tbs || tbs.tag !== SEQUENCE) throw new Error('der: missing tbsCertificate');
  const extsWrapper = children(certDer, tbs).find((t) => t.tag === EXTENSIONS_TAG);
  if (!extsWrapper) return undefined;
  const extsSeq = children(certDer, extsWrapper);
  if (extsSeq.length !== 1 || extsSeq[0]?.tag !== SEQUENCE) throw new Error('der: bad extensions');
  let found: Buffer | undefined;
  for (const ext of children(certDer, extsSeq[0])) {
    if (ext.tag !== SEQUENCE) throw new Error('der: bad extension');
    const parts = children(certDer, ext);
    const id = parts[0];
    if (!id || id.tag !== OID) throw new Error('der: extension without oid');
    let i = 1;
    if (parts[i]?.tag === BOOLEAN) i++;
    const value = parts[i];
    if (!value || value.tag !== OCTET_STRING || parts.length !== i + 1)
      throw new Error('der: bad extension value');
    if (decodeOid(certDer.subarray(id.start, id.end)) === oid) {
      if (found) throw new Error('der: duplicate extension');
      found = certDer.subarray(value.start, value.end);
    }
  }
  return found;
}

/**
 * Apple App Attest nonce extension (OID 1.2.840.113635.100.8.2): a SEQUENCE holding a single
 * [1]-tagged OCTET STRING. Returns that octet string. Anything else throws.
 */
export function parseAppAttestNonceExtension(value: Buffer): Buffer {
  const seq = readTlv(value, 0, value.length);
  if (seq.tag !== SEQUENCE || seq.end !== value.length)
    throw new Error('der: nonce extension not a sequence');
  const inner = children(value, seq);
  if (inner.length !== 1 || inner[0]?.tag !== 0xa1) throw new Error('der: nonce extension shape');
  const octets = children(value, inner[0]);
  if (octets.length !== 1 || octets[0]?.tag !== OCTET_STRING) throw new Error('der: nonce extension shape');
  return value.subarray(octets[0].start, octets[0].end);
}
