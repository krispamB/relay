/** Units assigned to one call, and the public id the app is allowed to see. Plan §5.1, D11. */

import { hmacHex } from '../crypto.js';

export function unitsForCall<T extends { destinationType: number | null; destinationId: string | null }>(
  statuses: T[],
  callId: string,
): T[] {
  const id = callId.trim();
  return statuses.filter(
    (status) =>
      status.destinationType === 2 && status.destinationId !== null && status.destinationId.trim() === id,
  );
}

/** `u_` plus the first 32 hex characters of HMAC-SHA256(secret, core unit id). */
export function unitKey(secret: string, coreUnitId: string): string {
  return `u_${hmacHex(secret, coreUnitId).slice(0, 32)}`;
}
