import { describe, expect, it } from 'vitest';
import { haversineMeters } from '../../src/live/geo.js';

describe('haversineMeters', () => {
  it('matches the London–Paris great-circle distance within 0.5%', () => {
    const metres = haversineMeters({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 });
    const expected = 343_556;
    expect(Math.abs(metres - expected) / expected).toBeLessThan(0.005);
  });

  it('is zero when both points are the same', () => {
    expect(haversineMeters({ lat: 4.9247, lon: 6.2676 }, { lat: 4.9247, lon: 6.2676 })).toBe(0);
  });

  it('takes the short path across the antimeridian', () => {
    const metres = haversineMeters({ lat: 0, lon: 179 }, { lat: 0, lon: -179 });
    const twoDegreesAtEquator = 222_390;
    expect(Math.abs(metres - twoDegreesAtEquator) / twoDegreesAtEquator).toBeLessThan(0.005);
  });
});
