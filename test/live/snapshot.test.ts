import { describe, expect, it } from 'vitest';
import { MINUTE } from '../../src/clock.js';
import { buildSnapshot, type SnapshotInput } from '../../src/live/snapshot.js';

const NOW = new Date('2026-11-22T09:14:05.000Z');

function input(
  overrides: Partial<SnapshotInput> = {},
  submission: Partial<SnapshotInput['submission']> = {},
): SnapshotInput {
  return {
    submission: {
      id: 'sos_01JTEST',
      reference: 'SOS-7KQ2',
      status: 'dispatched',
      updatedAt: NOW,
      liveVersion: 17,
      lat: 0,
      lon: 0,
      liveLat: null,
      liveLon: null,
      liveAt: null,
      ...submission,
    },
    recording: 'none',
    units: [],
    ...overrides,
  };
}

describe('buildSnapshot', () => {
  it('builds the state document from the submission, with no units unless it is dispatched', () => {
    const snap = buildSnapshot(
      input(
        {
          recording: 'attached',
          units: [
            {
              unitKey: 'u_abc',
              unitType: 'Ambulance',
              statusText: 'En Route',
              lat: 1,
              lon: 1,
              statusAt: new Date('2026-11-22T09:13:58.000Z'),
            },
          ],
        },
        { status: 'received' },
      ),
      NOW,
    );

    expect(snap).toEqual({
      type: 'state',
      version: 17,
      receiptId: 'sos_01JTEST',
      reference: 'SOS-7KQ2',
      status: 'received',
      updatedAt: '2026-11-22T09:14:05.000Z',
      recording: { status: 'attached' },
      units: [],
    });
  });

  it('measures distance from a live fix under 2 minutes old, and rounds to whole metres', () => {
    const snap = buildSnapshot(
      input(
        {
          units: [
            {
              unitKey: 'u_near',
              unitType: 'Ambulance',
              statusText: 'En Route',
              lat: 0,
              lon: 0.00001349,
              statusAt: new Date('2026-11-22T09:13:58.000Z'),
            },
          ],
        },
        { lat: 10, lon: 10, liveLat: 0, liveLon: 0, liveAt: new Date(NOW.getTime() - MINUTE) },
      ),
      NOW,
    );

    expect(snap.units).toEqual([
      {
        key: 'u_near',
        type: 'Ambulance',
        status: 'En Route',
        lat: 0,
        lon: 0.00001349,
        distanceM: 2,
        updatedAt: '2026-11-22T09:13:58.000Z',
      },
    ]);
  });

  it('uses a live fix taken now, and falls back once the fix is 2 minutes old or in the future', () => {
    const unit = {
      unitKey: 'u_here',
      unitType: null,
      statusText: null,
      lat: 0,
      lon: 0,
      statusAt: null,
    };

    const atLive = buildSnapshot(
      input({ units: [unit] }, { lat: 10, lon: 10, liveLat: 0, liveLon: 0, liveAt: NOW }),
      NOW,
    );
    expect(atLive.units[0]).toMatchObject({ distanceM: 0 });
    expect(atLive.units[0]).not.toHaveProperty('updatedAt');

    const stale = buildSnapshot(
      input(
        { units: [unit] },
        { lat: 10, lon: 10, liveLat: 0, liveLon: 0, liveAt: new Date(NOW.getTime() - 2 * MINUTE) },
      ),
      NOW,
    );
    expect(stale.units[0]?.distanceM).toBeGreaterThan(1_000_000);

    const future = buildSnapshot(
      input(
        { units: [unit] },
        { lat: 0, lon: 0, liveLat: 10, liveLon: 10, liveAt: new Date(NOW.getTime() + 1) },
      ),
      NOW,
    );
    expect(future.units[0]).toMatchObject({ distanceM: 0 });
  });

  it('falls back to the incident location, and omits distance when neither fix is usable', () => {
    const unit = {
      unitKey: 'u_unit',
      unitType: 'Patrol',
      statusText: 'On Scene',
      lat: 0,
      lon: 1,
      statusAt: NOW,
    };

    const fromIncident = buildSnapshot(
      input({ units: [unit] }, { lat: 0, lon: 0, liveLat: 0, liveLon: null, liveAt: NOW }),
      NOW,
    );
    expect(fromIncident.units[0]?.distanceM).toBe(111195);

    const nowhere = buildSnapshot(
      input({ units: [unit] }, { lat: null, lon: null, liveLat: null, liveLon: null, liveAt: null }),
      NOW,
    );
    expect(nowhere.units[0]).toEqual({
      key: 'u_unit',
      type: 'Patrol',
      status: 'On Scene',
      lat: 0,
      lon: 1,
      updatedAt: NOW.toISOString(),
    });
    expect(nowhere.units[0]).not.toHaveProperty('distanceM');
  });

  it('omits coordinates and distance when a unit has no position, and sorts by distance then key', () => {
    const snap = buildSnapshot(
      input({
        units: [
          { unitKey: 'u_z', unitType: 'B', statusText: 'Close', lat: 0, lon: 0, statusAt: NOW },
          { unitKey: 'u_far', unitType: 'A', statusText: 'Going', lat: 0, lon: 2, statusAt: NOW },
          { unitKey: 'u_b', unitType: null, statusText: null, lat: null, lon: 5, statusAt: NOW },
          { unitKey: 'u_near', unitType: 'B', statusText: 'Close', lat: 0, lon: 0, statusAt: NOW },
          { unitKey: 'u_a', unitType: null, statusText: null, lat: null, lon: null, statusAt: NOW },
          { unitKey: 'u_mid', unitType: 'C', statusText: 'Mid', lat: 0, lon: 1, statusAt: NOW },
        ],
      }),
      NOW,
    );

    expect(snap.units.map((u) => u.key)).toEqual(['u_near', 'u_z', 'u_mid', 'u_far', 'u_a', 'u_b']);
    expect(snap.units[0]?.distanceM).toBe(0);
    expect(snap.units[1]?.distanceM).toBe(0);
    expect(snap.units[2]?.distanceM).toBe(111195);
    expect(snap.units[3]?.distanceM).toBe(222390);
    expect(snap.units[4]).not.toHaveProperty('lat');
    expect(snap.units[4]).not.toHaveProperty('lon');
    expect(snap.units[4]).not.toHaveProperty('distanceM');
    expect(snap.units[5]).not.toHaveProperty('lat');
  });
});
