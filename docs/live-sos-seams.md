# Live SOS build: work split and seams

Build notes for `docs/live-sos-plan.md` (the spec). This file fixes the interfaces that parallel
work streams code against, so they can be built at the same time and merged without guessing.
Where this file and the plan disagree, the plan wins and this file is fixed.

Integration branch: `feat/live-sos`. Each stream works in its own worktree branched from it and
commits there; the orchestrator merges streams back in the order below.

## Phases

| Phase | Stream | Slices | Owns (new or primary files) |
|---|---|---|---|
| A | **A1 auth** | 1, 2, 3 | `migrations/006_live_sos.sql` (all of plan §6), `src/db/types.ts`, `src/auth/**`, `src/routes/sos.ts`, `src/routes/status.ts`, `src/sos/**`, `src/abuse/**`, `src/delivery/mapping.ts`, `src/config.ts`, `src/live/version.ts`, deletes `src/devices`, `src/attestation`, `src/routes/devices.ts` |
| A | **A2 core** | Core half of 5 and 8 | `src/core/client.ts`, `src/core/types.ts`, `mock-core/**`, `scripts/live-checklist.ts` |
| A | **A3 pure** | Pure parts of 4, 6, 7, 8 | `src/live/geo.ts`, `src/live/units.ts`, `src/live/snapshot.ts`, `src/live/protocol.ts`, `src/recordings/container.ts` |
| A | **A4 docs** | Most of 9 | `docs/auth-contract.md`, `docs/app-api-contract.md`, `docs/attestation-contract.md`, `integration.md`, `sos-relay-PRD.md` |
| B | **B1 recordings** | 4, 5 | `src/recordings/**` (except `container.ts`), `src/routes/recording.ts`, `src/jobs/recordingWorker.ts` |
| B | **B2 live state** | 6, 8 | `src/live/read.ts`, `src/jobs/statusPoller.ts`, `src/jobs/unitPoller.ts` (or a step in the poller) |
| C | **C1 socket** | 7 | `src/live/socket.ts`, `src/live/listener.ts`, `src/routes/live.ts` |
| D | orchestrator | 9 rest, review | OpenAPI export, README, merge, full suite, review |

A1 is the critical path: B and C start from the branch once A1 is merged.

## Seam 1: schema (A1 writes, everyone reads)

`migrations/006_live_sos.sql` holds **all** of plan §6, including the tables and columns that only
later streams use, so no later stream writes a migration. Column names are exactly these.

`submissions` gains `user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE`,
`live_version bigint NOT NULL DEFAULT 0`, `live_watch_until timestamptz`, `live_lat double precision`,
`live_lon double precision`, `live_at timestamptz`. It loses `device_id`, `nature_id`, `name`, `details`.

`relay_state` gains `units_next_poll_at timestamptz`.

```sql
CREATE TABLE recordings (
  id               text PRIMARY KEY,               -- 'rec_' + ULID
  submission_id    text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  seq              integer NOT NULL,               -- 1-based
  idempotency_key  text NOT NULL,
  body_hash        text NOT NULL,                  -- SHA-256 hex of the bytes
  bytes            bytea,                          -- NULL once attached or dropped
  size             integer NOT NULL,
  duration_ms      integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending','attached','dropped')),
  core_file_id     text,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  drop_reason      text,
  created_at       timestamptz NOT NULL,
  attached_at      timestamptz,
  UNIQUE (submission_id, seq),
  UNIQUE (submission_id, idempotency_key)
);
-- plus an index for the worker: (next_attempt_at) WHERE status = 'pending'

CREATE TABLE submission_units (
  submission_id  text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  unit_key       text NOT NULL,                    -- see Seam 4, unitKey()
  unit_type      text,
  status_text    text,
  lat            double precision,
  lon            double precision,
  status_at      timestamptz,
  PRIMARY KEY (submission_id, unit_key)
);
```

Kysely types in `src/db/types.ts`: `RecordingsTable` (key `recordings`), `SubmissionUnitsTable`
(key `submission_units`), `RecordingStatus = 'pending' | 'attached' | 'dropped'`,
`SubjectType = 'user' | 'phone'`. `live_version` is a `BigIntCol` (read as a string; convert with
`Number()`).

## Seam 2: live version bump (A1 writes `src/live/version.ts`)

```ts
export const LIVE_CHANNEL = 'sos_live';
/** live_version + 1 and NOTIFY sos_live '<id>'. Call inside the transaction that commits the change. */
export async function bumpLiveVersion(db: Kysely<Database> | Transaction<Database>, submissionId: string): Promise<void>;
```

`NOTIFY` inside a transaction is delivered on commit, so callers just call it in their transaction.
B1 calls it on recording insert and status change; B2 wires it into every submission status change
and unit change; C1 listens on `LIVE_CHANNEL`.

## Seam 3: Core client (A2 adds to `CoreClient`)

```ts
export interface CoreUnitStatus {
  unitId: string;              // Core UnitId, as a string
  unitType: string | null;     // Core's unit type name
  statusText: string | null;   // Core's status text, e.g. "En Route"
  destinationType: number | null; // 1 station, 2 call, 3 POI
  destinationId: string | null;   // as a string
  latitude: number | null;
  longitude: number | null;
  timestamp: string | null;    // ISO 8601 of the status
}

saveCallFile(
  input: { callId: string; name: string; data: Buffer },
  opts?: { timeoutMs?: number },
): Promise<CoreResult<{ fileId: string }> | { kind: 'call_closed' }>;

getAllUnitStatuses(): Promise<CoreResult<{ units: CoreUnitStatus[] }>>;
```

`saveCallFile` sends `{ CallId, UserId: <fixed placeholder>, Type: 1, Name, Data: base64 }` and maps
Core's "call is not active/pending" answer to `{ kind: 'call_closed' }`. Every in-repo
`CoreClient` implementation (fakes in tests, `scripts/openapi.ts`) gains both methods.

## Seam 4: pure live modules (A3 writes, no DB, no Fastify)

```ts
// src/live/geo.ts
export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number;

// src/live/units.ts  (input is structurally CoreUnitStatus)
export function unitsForCall<T extends { destinationType: number | null; destinationId: string | null }>(statuses: T[], callId: string): T[];
export function unitKey(secret: string, coreUnitId: string): string; // 'u_' + 32 hex of HMAC-SHA256

// src/live/snapshot.ts
export type RecordingView = 'none' | 'pending' | 'attached' | 'dropped';
export interface SnapshotInput {
  submission: {
    id: string; reference: string; status: SubmissionStatus; updatedAt: Date; liveVersion: number;
    lat: number | null; lon: number | null;           // incident location
    liveLat: number | null; liveLon: number | null; liveAt: Date | null; // caller's live location
  };
  recording: RecordingView;                             // status of the highest-seq recording, or 'none'
  units: Array<{ unitKey: string; unitType: string | null; statusText: string | null;
                 lat: number | null; lon: number | null; statusAt: Date | null }>;
}
export interface LiveSnapshot { /* exactly plan §5.3, type: 'state' */ }
export const LiveSnapshotSchema: TSchema; // TypeBox, for the HTTP status route and OpenAPI
export function buildSnapshot(input: SnapshotInput, now: Date): LiveSnapshot;

// src/live/protocol.ts
export const CLOSE = { final: 1000, restart: 1012, unauthorized: 4001, revoked: 4003, notFound: 4004, idle: 4008,
                       tooManySockets: 4029 } as const;   // 4029 added by C1: the per-user socket cap
export const MAX_MESSAGE_BYTES = 8 * 1024;               // added by C1: also the socket's frame limit
export type ServerErrorCode = 'bad_message' | 'not_subscribed' | 'invalid_location' | 'rate_limited' | 'unavailable';
export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; receiptId: string }
  | { type: 'location'; lat: number; lon: number; accuracyM?: number; capturedAt: string }
  | { type: 'ping' };
export function parseClientMessage(raw: string): { ok: true; message: ClientMessage } | { ok: false; code: 'bad_message' };

// src/recordings/container.ts
export function looksLikeMp4(bytes: Uint8Array): boolean; // first box is 'ftyp' with a sane size
```

Freshness rules for a socket `location` (at most 10 minutes old, not in the future, not 0,0) reuse the
SOS body validator in `src/sos/validate.ts`; `protocol.ts` only checks shape and ranges.

## Seam 5: snapshot read (B2 writes `src/live/read.ts`, C1 uses it)

```ts
/** The snapshot for one SOS, or null if it does not exist or is not this user's. */
export async function readSnapshot(db: Db, submissionId: string, userId: string, now: Date): Promise<LiveSnapshot | null>;
/** Same, without the owner check, for fan-out after a NOTIFY. */
export async function readSnapshotById(db: Db, submissionId: string, now: Date): Promise<(LiveSnapshot & { userId: string }) | null>;

// src/live/watch.ts: call on subscribe and on every ping.
export const WATCH_MS: number;            // 60 s
export const WATCHED_INTERVAL_MS: number; // 15 s, the per-call floor
/** live_watch_until = max(current, now + 60 s); a dispatched or closed SOS's next GetCall is pulled
 *  earlier, never below last_poll_at + 15 s. Unknown ids are ignored. */
export async function watchSubmission(db: Db, submissionId: string, now: Date): Promise<void>;
```

Snapshot reads run in one repeatable-read transaction. `updatedAt` is the latest status change.
Migration `007_live_poll_floor.sql` adds `submissions.last_poll_at` (when the poller last claimed the
row for a Core read), which the floor counts from.

## Seam 6: live socket (C1 writes)

- Migration `008_live_socket.sql` adds `submissions.live_stored_at` (when the relay last stored a
  socket location; the 1-per-5-s limit counts from it) and a trigger on `token_families` that sends
  `NOTIFY session_revoked '<family id>'` when `revoked_at` goes from NULL to a value, or the row is
  deleted, inside that transaction. `SESSION_REVOKED_CHANNEL` in `src/auth/sessions.ts` names it.
- `src/auth/requireUser.ts` exports `verifyAccess(ctx, keys, token, options)`: `authenticate` without
  the Bearer header and without the per-user rate limit. `AuthenticatedAccess` gains `expiresAt`.
- `buildPublicApp(ctx, { live?: Partial<LiveOptions> })`: the socket's timeouts and limits
  (`src/live/socket.ts`), shortened by the tests.
- `storeLiveLocation(db, submissionId, userId, fix, now)` in `src/live/location.ts`.

## Rules for every stream

- Test-first against real Postgres in testcontainers, like the existing suite. Docker must be running.
- `npm run typecheck`, single test files while working (`npx vitest run test/path.test.ts`),
  `npm run lint`. The full suite runs once at the end of the stream.
- Stay inside your owned files; touch others only where the seam requires it, and say so in the
  final report.
- One commit per slice (or per coherent part), message style like the existing history.
