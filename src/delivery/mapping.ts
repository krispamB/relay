/** Submission row → Core SaveCall input. sos-relay-PRD.md §8.2, §13.3; integration.md §4.2, §7. Pure. */
import type { Config } from '../config.js';
import type { SaveCallInput } from '../core/types.js';
import type { Submission } from '../db/types.js';

export const PLACEHOLDER_ADDRESS = 'See map location';
export const PLACEHOLDER_NAME = 'Unknown caller';
export const NAME_MAX = 100;

/** relay_state.required_address / required_name: Core's field policy requires the field. */
export interface FieldPolicyFlags {
  requiredAddress: boolean;
  requiredName: boolean;
}

export type MappingSubmission = Pick<
  Submission,
  | 'id'
  | 'reference'
  | 'nature_label'
  | 'details'
  | 'phone'
  | 'name'
  | 'lat'
  | 'lon'
  | 'accuracy_m'
  | 'location_captured_at'
  | 'location_source'
  | 'address'
  | 'accepted_at'
>;

function text(v: string | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** "lat,lon", six decimals, dot separator, no spaces. Undefined without a real point. */
export function formatGeolocation(lat: number | null, lon: number | null): string | undefined {
  if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  if (lat === 0 && lon === 0) return undefined;
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/** ISO 8601 to the second, e.g. 2026-11-17T14:03:22Z. */
function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The note block of PRD §8.2. Lines with no data are left out. */
export function buildNote(sub: MappingSubmission): string {
  const lines = [
    'Public SOS submission (unverified member of the public)',
    `Submitted: ${isoSeconds(sub.accepted_at)}   Reference: ${sub.reference}`,
  ];
  const phone = text(sub.phone);
  if (phone) lines.push(`Phone: ${phone} (unverified)`);

  const geo = formatGeolocation(sub.lat, sub.lon);
  if (geo) {
    const parts = [`Location: ${geo}`];
    if (sub.accuracy_m !== null && Number.isFinite(sub.accuracy_m)) {
      parts.push(`accuracy ±${Math.round(sub.accuracy_m)} m`);
    }
    if (sub.location_source) parts.push(`source ${sub.location_source}`);
    if (sub.location_captured_at) {
      const ageS = Math.max(
        0,
        Math.round((sub.accepted_at.getTime() - sub.location_captured_at.getTime()) / 1000),
      );
      parts.push(`captured ${ageS} s before submission`);
    }
    lines.push(parts.join('  '));
  }

  const address = text(sub.address);
  if (address) lines.push(`Address given: ${address}`);
  return lines.join('\n');
}

export function buildSaveCallInput(
  sub: MappingSubmission,
  resgrid: Pick<Config['resgrid'], 'callTypeName' | 'priorityId'>,
  policy: FieldPolicyFlags,
): SaveCallInput {
  const label = sub.nature_label.trim();
  const details = text(sub.details);
  const geolocation = formatGeolocation(sub.lat, sub.lon);

  let address = text(sub.address);
  // Only an honest placeholder: the caller sent a location but no address.
  if (address === undefined && policy.requiredAddress && geolocation !== undefined) {
    address = PLACEHOLDER_ADDRESS;
  }
  let contactName = text(sub.name);
  if (contactName === undefined && policy.requiredName) contactName = PLACEHOLDER_NAME;

  const input: SaveCallInput = {
    Priority: resgrid.priorityId,
    Type: text(resgrid.callTypeName),
    Name: `[PUBLIC SOS] ${label}`.slice(0, NAME_MAX),
    Nature: details ? `${label}. ${details}` : label,
    Geolocation: geolocation,
    Address: address,
    ContactName: contactName,
    ContactInfo: text(sub.phone),
    ExternalId: sub.id,
    ReferenceId: sub.reference,
    Note: buildNote(sub),
  };
  // Drop undefined keys so the object itself carries only fields with data.
  for (const k of Object.keys(input) as (keyof SaveCallInput)[]) {
    if (input[k] === undefined) delete input[k];
  }
  return input;
}
