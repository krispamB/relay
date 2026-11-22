import { describe, expect, it } from 'vitest';
import { buildSaveCallBody, SAVE_CALL_FIELDS } from '../../src/core/client.js';
import { retryDelaySeconds } from '../../src/delivery/backoff.js';
import {
  buildNote,
  buildSaveCallInput,
  formatGeolocation,
  type MappingSubmission,
  PLACEHOLDER_ADDRESS,
  PLACEHOLDER_NAME,
} from '../../src/delivery/mapping.js';

const resgrid = { callTypeName: 'Public SOS', priorityId: 3 };
const noPolicy = { requiredAddress: false, requiredName: false };

function sub(overrides: Partial<MappingSubmission> = {}): MappingSubmission {
  return {
    id: 'sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD',
    reference: 'SOS-7KQ2',
    nature_label: 'SOS – caller recording to follow',
    phone: '+2348012345678',
    contact_name: null,
    lat: null,
    lon: null,
    accuracy_m: null,
    location_captured_at: null,
    location_source: null,
    address: null,
    accepted_at: new Date('2026-11-17T14:03:22.456Z'),
    ...overrides,
  };
}

const withLocation: Partial<MappingSubmission> = {
  lat: 6.5244,
  lon: 3.3792,
  accuracy_m: 12.4,
  location_source: 'gps',
  location_captured_at: new Date('2026-11-17T14:03:14.000Z'),
};

describe('note block (PRD §8.2)', () => {
  it('matches the documented example with every line', () => {
    expect(buildNote(sub({ ...withLocation, address: '12 Marina Rd' }))).toBe(
      [
        'Public SOS submission (unverified member of the public)',
        'Submitted: 2026-11-17T14:03:22Z   Reference: SOS-7KQ2',
        'Phone: +2348012345678 (unverified)',
        'Location: 6.524400,3.379200  accuracy ±12 m  source gps  captured 8 s before submission',
        'Address given: 12 Marina Rd',
      ].join('\n'),
    );
  });
  it('leaves out lines with no data', () => {
    expect(buildNote(sub({ address: '12 Marina Rd' }))).toBe(
      [
        'Public SOS submission (unverified member of the public)',
        'Submitted: 2026-11-17T14:03:22Z   Reference: SOS-7KQ2',
        'Phone: +2348012345678 (unverified)',
        'Address given: 12 Marina Rd',
      ].join('\n'),
    );
    expect(buildNote(sub({ ...withLocation }))).not.toContain('Address given');
  });
  it('leaves out location parts that are missing', () => {
    const note = buildNote(sub({ lat: -1.5, lon: 36.8 }));
    expect(note).toContain('Location: -1.500000,36.800000');
    expect(note).not.toMatch(/accuracy|source|captured/);
  });
  it('computes "captured N s before submission" from accepted_at − location_captured_at', () => {
    const note = buildNote(
      sub({ ...withLocation, location_captured_at: new Date('2026-11-17T14:00:22.456Z') }),
    );
    expect(note).toContain('captured 180 s before submission');
  });
});

describe('buildSaveCallInput (PRD §8.2)', () => {
  it('maps a full submission: fixed Name, the relay nature, the account name and phone', () => {
    const input = buildSaveCallInput(
      sub({ ...withLocation, address: '12 Marina Rd', contact_name: 'Ade Okafor' }),
      resgrid,
      noPolicy,
    );
    expect(input).toEqual({
      Priority: 3,
      Type: 'Public SOS',
      Name: '[PUBLIC SOS] SOS',
      Nature: 'SOS – caller recording to follow',
      Geolocation: '6.524400,3.379200',
      Address: '12 Marina Rd',
      ContactName: 'Ade Okafor',
      ContactInfo: '+2348012345678',
      ExternalId: 'sos_01JCQ8Z3M5V7T9W2X4Y6A8B0CD',
      ReferenceId: 'SOS-7KQ2',
      Note: expect.stringContaining('Public SOS submission'),
    });
  });
  it('omits location, address and name when not given', () => {
    const input = buildSaveCallInput(sub({ address: 'Somewhere' }), resgrid, noPolicy);
    expect(input.Nature).toBe('SOS – caller recording to follow');
    expect(input).not.toHaveProperty('Geolocation');
    expect(input).not.toHaveProperty('ContactName');
    const body = buildSaveCallBody(input);
    expect(body).not.toHaveProperty('Geolocation');
    expect(body).not.toHaveProperty('ContactName');
    for (const k of Object.keys(body)) expect((SAVE_CALL_FIELDS as readonly string[]).includes(k)).toBe(true);
  });
  it('never sends a 0,0 point', () => {
    expect(formatGeolocation(0, 0)).toBeUndefined();
    expect(formatGeolocation(null, 3)).toBeUndefined();
    expect(formatGeolocation(6.5, 3.25)).toBe('6.500000,3.250000');
  });
  it('keeps Name fixed whatever the nature text', () => {
    const input = buildSaveCallInput(sub({ nature_label: 'X'.repeat(200) }), resgrid, noPolicy);
    expect(input.Name).toBe('[PUBLIC SOS] SOS');
    expect(input.Nature).toBe('X'.repeat(200));
  });
  it('sends "See map location" when the policy requires an address and only GPS was sent', () => {
    const input = buildSaveCallInput(sub(withLocation), resgrid, {
      requiredAddress: true,
      requiredName: false,
    });
    expect(input.Address).toBe(PLACEHOLDER_ADDRESS);
    expect(input.Note).not.toContain('Address given');
  });
  it('keeps the caller address over the placeholder, and sends no placeholder without a location', () => {
    expect(
      buildSaveCallInput(sub({ ...withLocation, address: 'Real St' }), resgrid, {
        requiredAddress: true,
        requiredName: false,
      }).Address,
    ).toBe('Real St');
    expect(
      buildSaveCallInput(sub(), resgrid, { requiredAddress: true, requiredName: false }),
    ).not.toHaveProperty('Address');
  });
  it('does not send a placeholder address when the policy does not require one', () => {
    expect(buildSaveCallInput(sub(withLocation), resgrid, noPolicy)).not.toHaveProperty('Address');
  });
  it('sends "Unknown caller" when the policy requires a name and none was given', () => {
    expect(
      buildSaveCallInput(sub({ address: 'a' }), resgrid, { requiredAddress: false, requiredName: true })
        .ContactName,
    ).toBe(PLACEHOLDER_NAME);
    expect(
      buildSaveCallInput(sub({ address: 'a', contact_name: 'Ade' }), resgrid, {
        requiredAddress: false,
        requiredName: true,
      }).ContactName,
    ).toBe('Ade');
  });
});

describe('backoff (PRD §8.3)', () => {
  it('follows 5, 15, 30, 60, then every 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => retryDelaySeconds(n))).toEqual([5, 15, 30, 60, 60, 60, 60]);
  });
  it('lets Retry-After override the next delay', () => {
    expect(retryDelaySeconds(1, 120)).toBe(120);
    expect(retryDelaySeconds(5, 2)).toBe(2);
    expect(retryDelaySeconds(1, 0)).toBe(1);
  });
});
