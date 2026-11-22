import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { unitKey, unitsForCall } from '../../src/live/units.js';

interface Row {
  destinationType: number | null;
  destinationId: string | null;
  name: string;
}

const row = (destinationType: number | null, destinationId: string | null, name: string): Row => ({
  destinationType,
  destinationId,
  name,
});

describe('unitsForCall', () => {
  it('keeps only destination type 2 whose id matches the call, compared as trimmed strings', () => {
    const rows = [
      row(2, '  call-1 ', 'kept'),
      row(2, 'call-2', 'other call'),
      row(1, 'call-1', 'wrong type'),
      row(null, 'call-1', 'no type'),
      row(2, null, 'no id'),
      row(2, '   ', 'blank id'),
      row(2, 'call-1', 'also kept'),
    ];

    expect(unitsForCall(rows, ' call-1 ').map((r) => r.name)).toEqual(['kept', 'also kept']);
  });

  it('drops every row when nothing is assigned to the call', () => {
    expect(unitsForCall([row(2, 'other', 'a'), row(3, 'call-1', 'b')], 'call-1')).toEqual([]);
  });
});

describe('unitKey', () => {
  it('is u_ plus the first 32 hex characters of HMAC-SHA256, and it is stable', () => {
    const expected = `u_${createHmac('sha256', 'secret').update('core-unit-9').digest('hex').slice(0, 32)}`;
    expect(unitKey('secret', 'core-unit-9')).toBe(expected);
    expect(unitKey('secret', 'core-unit-9')).toBe(unitKey('secret', 'core-unit-9'));
    expect(unitKey('secret', 'core-unit-9')).toMatch(/^u_[0-9a-f]{32}$/);
  });

  it('differs when the secret differs', () => {
    expect(unitKey('secret-a', 'core-unit-9')).not.toBe(unitKey('secret-b', 'core-unit-9'));
  });
});
