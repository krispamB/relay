import { safeError } from '../errors.js';
import type { Logger } from '../logger.js';

/** A background job. `run` does one pass and must be safe to call again after a failure. */
export interface Job {
  name: string;
  intervalMs: number;
  run(): Promise<void>;
}

/** Runs each job in its own loop. stop() waits for in-flight passes to finish (graceful shutdown). */
export function startJobs(jobs: Job[], log: Logger): { stop(): Promise<void> } {
  let stopping = false;
  const timers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();

  const schedule = (job: Job, delay: number) => {
    if (stopping) return;
    const timer = setTimeout(() => {
      const pass = job
        .run()
        .catch((err) => log.error({ error: safeError(err), job: job.name }, 'job pass failed'))
        .finally(() => {
          inFlight.delete(pass);
          schedule(job, job.intervalMs);
        });
      inFlight.add(pass);
    }, delay);
    timers.set(job.name, timer);
  };

  for (const job of jobs) schedule(job, 0);

  return {
    async stop() {
      stopping = true;
      for (const t of timers.values()) clearTimeout(t);
      await Promise.allSettled([...inFlight]);
    },
  };
}
