import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** One Postgres for the whole run. Set TEST_DATABASE_URL to use an existing database instead. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    url = container.getConnectionUri();
  }
  await migrate(url);
  project.provide('databaseUrl', url);
  return async () => {
    await container?.stop();
  };
}
