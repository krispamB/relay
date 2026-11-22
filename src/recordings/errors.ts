/** The recording upload's own refusals (docs/live-sos-plan.md §3.4), in the relay's error envelope. */
import { ApiError } from '../errors.js';

export const recordingErrors = {
  limit: () => new ApiError(409, 'recording_limit', 'This SOS already has its recording.'),
  sosClosed: () =>
    new ApiError(409, 'sos_closed', 'This SOS has ended, so a recording can no longer be attached.'),
  keyReused: () =>
    new ApiError(
      422,
      'idempotency_key_reused',
      'This Idempotency-Key was already used for a different recording.',
    ),
  invalid: (message: string) => new ApiError(400, 'invalid_request', message),
};
