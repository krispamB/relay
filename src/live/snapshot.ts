/** Full versioned snapshot pushed to the app. Plan §5.3, D18. */

import { type TSchema, Type } from '@sinclair/typebox';
import { MINUTE } from '../clock.js';
import type { SubmissionStatus } from '../db/types.js';
import { SubmissionStatusSchema } from '../sos/schemas.js';
import { haversineMeters } from './geo.js';

export type RecordingView = 'none' | 'pending' | 'attached' | 'dropped';

export interface SnapshotInput {
  submission: {
    id: string;
    reference: string;
    status: SubmissionStatus;
    updatedAt: Date;
    liveVersion: number;
    /** Incident location. */
    lat: number | null;
    lon: number | null;
    /** Caller's live location. */
    liveLat: number | null;
    liveLon: number | null;
    liveAt: Date | null;
  };
  /** Status of the highest-seq recording, or `none`. */
  recording: RecordingView;
  units: Array<{
    unitKey: string;
    unitType: string | null;
    statusText: string | null;
    lat: number | null;
    lon: number | null;
    statusAt: Date | null;
  }>;
}

export interface LiveUnit {
  key: string;
  type: string | null;
  status: string | null;
  lat?: number;
  lon?: number;
  distanceM?: number;
  updatedAt?: string;
}

/** `type: 'state'` document from plan §5.3. */
export interface LiveSnapshot {
  type: 'state';
  version: number;
  receiptId: string;
  reference: string;
  status: SubmissionStatus;
  updatedAt: string;
  recording: { status: RecordingView };
  units: LiveUnit[];
}

const RecordingStatusSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('pending'),
  Type.Literal('attached'),
  Type.Literal('dropped'),
]);

const LiveUnitSchema = Type.Object(
  {
    key: Type.String(),
    type: Type.Union([Type.String(), Type.Null()]),
    status: Type.Union([Type.String(), Type.Null()]),
    lat: Type.Optional(Type.Number()),
    lon: Type.Optional(Type.Number()),
    distanceM: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);

export const LiveSnapshotSchema = Type.Object(
  {
    type: Type.Literal('state'),
    version: Type.Integer({ minimum: 0 }),
    receiptId: Type.String(),
    reference: Type.String(),
    status: SubmissionStatusSchema,
    updatedAt: Type.String({ format: 'date-time' }),
    recording: Type.Object({ status: RecordingStatusSchema }, { additionalProperties: false }),
    units: Type.Array(LiveUnitSchema),
  },
  { additionalProperties: false },
) satisfies TSchema;

interface LatLon {
  lat: number;
  lon: number;
}

/** A live fix is usable only while it is under 2 minutes old and not in the future. */
function referencePoint(submission: SnapshotInput['submission'], now: Date): LatLon | null {
  const { liveLat, liveLon, liveAt } = submission;
  if (liveLat !== null && liveLon !== null && liveAt !== null) {
    const age = now.getTime() - liveAt.getTime();
    if (age >= 0 && age < 2 * MINUTE) return { lat: liveLat, lon: liveLon };
  }
  if (submission.lat !== null && submission.lon !== null) return { lat: submission.lat, lon: submission.lon };
  return null;
}

function toUnit(unit: SnapshotInput['units'][number], origin: LatLon | null): LiveUnit {
  const view: LiveUnit = { key: unit.unitKey, type: unit.unitType, status: unit.statusText };
  if (unit.lat !== null && unit.lon !== null) {
    view.lat = unit.lat;
    view.lon = unit.lon;
    if (origin) view.distanceM = Math.round(haversineMeters(origin, { lat: unit.lat, lon: unit.lon }));
  }
  if (unit.statusAt) view.updatedAt = unit.statusAt.toISOString();
  return view;
}

function byDistanceThenKey(a: LiveUnit, b: LiveUnit): number {
  if (a.distanceM !== undefined && b.distanceM !== undefined && a.distanceM !== b.distanceM) {
    return a.distanceM - b.distanceM;
  }
  if ((a.distanceM === undefined) !== (b.distanceM === undefined)) return a.distanceM === undefined ? 1 : -1;
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

export function buildSnapshot(input: SnapshotInput, now: Date): LiveSnapshot {
  const origin = referencePoint(input.submission, now);
  const units =
    input.submission.status === 'dispatched'
      ? input.units.map((unit) => toUnit(unit, origin)).sort(byDistanceThenKey)
      : [];
  return {
    type: 'state',
    version: input.submission.liveVersion,
    receiptId: input.submission.id,
    reference: input.submission.reference,
    status: input.submission.status,
    updatedAt: input.submission.updatedAt.toISOString(),
    recording: { status: input.recording },
    units,
  };
}
