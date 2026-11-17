import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function hmacBase64Url(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison that does not leak length through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return timingSafeEqual(ha, hb);
}

/** PRD §7.4: derived, not stored, so a replay or 409 can return it again. */
export function statusTokenFor(secret: string, receiptId: string): string {
  return hmacBase64Url(secret, `status:${receiptId}`);
}

/** PRD §9.2: phone numbers in strikes, blocks and rate-limit lookups are keyed hashes. */
export function phoneHash(secret: string, e164: string): string {
  return hmacHex(secret, `phone:${e164}`);
}

/** Hash of a client IP for the registration log. */
export function ipHash(secret: string, ip: string): string {
  return hmacHex(secret, `ip:${ip}`);
}

/** PRD §7.4: h = SHA-256(Idempotency-Key + "\n" + raw request body bytes). */
export function bindingHash(idempotencyKey: string, rawBody: Buffer): Buffer {
  return createHash('sha256').update(idempotencyKey).update('\n').update(rawBody).digest();
}
