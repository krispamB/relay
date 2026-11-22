import type { AppContext } from '../context.js';
import { createDeliveryWorker } from './deliveryWorker.js';
import { createPolicyChecker } from './policyChecker.js';
import { createPurgeJob } from './purge.js';
import { createRecordingWorker } from './recordingWorker.js';
import type { Job } from './runner.js';
import { createStatusPoller } from './statusPoller.js';

/** Every background job (PRD §4). */
export function buildJobs(ctx: AppContext): Job[] {
  return [
    createDeliveryWorker(ctx),
    createRecordingWorker(ctx),
    createStatusPoller(ctx),
    createPolicyChecker(ctx),
    createPurgeJob(ctx),
  ];
}
