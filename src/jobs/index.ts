import type { AppContext } from '../context.js';
import { createDeliveryWorker } from './deliveryWorker.js';
import { createPolicyChecker } from './policyChecker.js';
import { createPurgeJob } from './purge.js';
import type { Job } from './runner.js';
import { createStatusPoller } from './statusPoller.js';

/** Every background job (PRD §4). */
export function buildJobs(ctx: AppContext): Job[] {
  return [createDeliveryWorker(ctx), createStatusPoller(ctx), createPolicyChecker(ctx), createPurgeJob(ctx)];
}
