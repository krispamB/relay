/**
 * Validation and sanitising of an SOS body. sos-relay-PRD.md §7.4, §13.3; docs/live-sos-plan.md §3.2.
 *
 * Split in two, because of the order of checks:
 * - `validateStatic` depends only on the request itself. It runs at step 3.
 * - `validateContent` depends on the clock and the Core field policy. It runs after the replay and
 *   open-SOS checks (steps 6 and 7), so a retry of an accepted SOS still gets its receipt when, say,
 *   its location has since gone stale.
 *
 * The location rules are shared with the live socket's `location` message (locationIsSound,
 * locationIsFresh). Every function here is pure. Errors carry a code only, never the offending value.
 */
import { MINUTE, SECOND } from '../clock.js';
import type { LocationSource } from '../db/types.js';
import { errors } from '../errors.js';
import { MAX_ADDRESS, type SosBody } from './schemas.js';

/** PRD §7.4: a fix older than this is not usable. */
export const MAX_LOCATION_AGE_MS = 10 * MINUTE;
/**
 * Phone clocks drift. A fix stamped up to this far ahead of the relay's clock is treated as "now"
 * rather than "in the future", so a slightly fast phone does not lose its location.
 */
export const LOCATION_CLOCK_SKEW_MS = 30 * SECOND;

export interface Location {
  lat: number;
  lon: number;
  accuracyM: number | null;
  capturedAt: Date;
  source: LocationSource;
}

/** The request after step 3: address sanitised, location statically sound or absent. */
export interface StaticSos {
  intakeCode: string;
  address: string | null;
  /** Passed the range and 0,0 checks; freshness is checked later. */
  location: Location | null;
}

/** What the caller sent that is stored, after step 7: the location is also fresh, or dropped. */
export type SosContent = StaticSos;

const WHITESPACE_CONTROLS = /[\t\n\v\f\r\u0085]/g;
const OTHER_CONTROLS = /\p{Cc}/gu;
const ANY_WHITESPACE = /\s+/gu;

/** PRD §7.4: strip control characters, collapse whitespace, trim. No HTML escaping. */
export function sanitizeText(input: string): string {
  return input
    .replace(WHITESPACE_CONTROLS, ' ')
    .replace(OTHER_CONTROLS, '')
    .replace(ANY_WHITESPACE, ' ')
    .trim();
}

/** Length in code points, so an emoji counts once. */
export function textLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Sanitises an optional text field. Empty after sanitising means absent. Over the limit is a 400. */
export function sanitizeField(value: string | undefined, max: number, code: string): string | null {
  if (value === undefined) return null;
  const clean = sanitizeText(value);
  if (clean === '') return null;
  if (textLength(clean) > max) throw errors.badRequest(code, 'A field is too long.');
  return clean;
}

/** Checks that need no clock: lat/lon in range and not 0,0, a parseable time. */
export function locationIsSound(loc: { lat: number; lon: number; capturedAt: string }): boolean {
  const { lat, lon } = loc;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return !Number.isNaN(Date.parse(loc.capturedAt));
}

/** PRD §7.4: at most 10 minutes old and not in the future (within a small clock-skew allowance). */
export function locationIsFresh(capturedAt: Date, now: Date): boolean {
  const age = now.getTime() - capturedAt.getTime();
  return age <= MAX_LOCATION_AGE_MS && age >= -LOCATION_CLOCK_SKEW_MS;
}

const noUsableLocation = () =>
  errors.badRequest('location_invalid', 'The location is not usable and no address was given.');

/** Step 3. Throws an ApiError 400. */
export function validateStatic(body: SosBody): StaticSos {
  const address = sanitizeField(body.address, MAX_ADDRESS, 'address_too_long');

  let location: Location | null = null;
  if (body.location) {
    if (locationIsSound(body.location)) {
      const acc = body.location.accuracyM;
      location = {
        lat: body.location.lat,
        lon: body.location.lon,
        // An impossible accuracy is dropped on its own; it does not make the fix unusable.
        accuracyM: acc !== undefined && Number.isFinite(acc) && acc >= 0 ? acc : null,
        capturedAt: new Date(body.location.capturedAt),
        source: body.location.source,
      };
    } else if (address === null) {
      throw noUsableLocation();
    }
  }
  if (location === null && address === null) {
    throw errors.badRequest('address_required', 'An address is required when there is no location.');
  }

  return { intakeCode: body.intakeCode, address, location };
}

/**
 * After step 7: location freshness against the clock, and the Core field policy's `geolocation`
 * requirement (PRD §13.3). Throws an ApiError 400.
 */
export function validateContent(
  sos: StaticSos,
  now: Date,
  policy: { requiredLocation: boolean },
): SosContent {
  let location = sos.location;
  if (location && !locationIsFresh(location.capturedAt, now)) {
    if (sos.address === null) throw noUsableLocation();
    location = null;
  }
  if (location === null && policy.requiredLocation) {
    throw errors.badRequest('location_required', 'This service needs a location with every SOS.');
  }
  return { ...sos, location };
}
