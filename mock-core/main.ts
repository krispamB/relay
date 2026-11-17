import { DEFAULT_API_KEY, startMockCore } from './server.js';

const port = Number(process.env.PORT ?? 4010);
const host = process.env.HOST ?? '0.0.0.0';
const apiKey = process.env.MOCK_CORE_API_KEY || DEFAULT_API_KEY;

const mock = await startMockCore({
  port,
  host,
  apiKey,
  callTypes: ['Public SOS'],
  priorities: [{ Id: 3, Name: 'High' }],
  logRequest: (line) => console.log(`${new Date().toISOString()} ${line}`),
});

console.log(
  `mock-core listening on ${host}:${port} (${process.env.MOCK_CORE_API_KEY ? 'API key from MOCK_CORE_API_KEY' : 'default API key'})`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void mock.close().finally(() => process.exit(0));
  });
}
