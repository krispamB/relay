/**
 * Review reproduction: src/db/index.ts creates a pg.Pool with no 'error' listener. When Postgres ends
 * an idle pooled connection (restart, failover, maintenance), pg-pool re-emits the error on the pool;
 * with no listener Node throws it as an uncaught exception and the whole relay exits, cutting every
 * in-flight POST /v1/sos. Regression test: failed until the pool gets an error listener.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, inject, it } from 'vitest';

it('the relay process survives Postgres terminating an idle pooled connection', () => {
  const child = fileURLToPath(new URL('./fixtures/poolCrashChild.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
  const res = spawnSync(tsx, [child], {
    env: { ...process.env, DATABASE_URL: inject('databaseUrl') },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.status !== 0) console.error(res.stderr.split('\n').slice(0, 8).join('\n'));
  expect({
    status: res.status,
    stdout: res.stdout.trim(),
    stderr: res.stderr
      .split('\n')
      .filter((l) => /error|terminat/i.test(l))
      .slice(0, 3),
  }).toMatchObject({
    status: 0,
    stdout: 'terminating idle backend\nsurvived',
  });
});
