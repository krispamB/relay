import type { AppContext } from '../context.js';
import type { Job } from './runner.js';

/** Every background job. Wired here as each one is built. */
export function buildJobs(_ctx: AppContext): Job[] {
  return [];
}
