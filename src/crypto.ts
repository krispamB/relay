import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** Constant-time string comparison that does not leak length through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return timingSafeEqual(ha, hb);
}

/** PRD §9.2: phone numbers in strikes, blocks and rate-limit lookups are keyed hashes. */
export function phoneHash(secret: string, e164: string): string {
  return hmacHex(secret, `phone:${e164}`);
}
