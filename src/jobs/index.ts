import type { AppContext } from '../context.js';
import { createDeliveryWorker } from './deliveryWorker.js';
import type { Job } from './runner.js';

/** Every background job. Wired here as each one is built. */
export function buildJobs(ctx: AppContext): Job[] {
  return [createDeliveryWorker(ctx)];
}
