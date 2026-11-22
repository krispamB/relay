import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';

/** A logger using createLogger's own options, writing into a buffer instead of stdout. */
function bufferedLogger() {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { log: createLogger('info', dest), text: () => chunks.join('') };
}

const TOKEN = 'eyJsecret-socket-token';
const LAT = 6.523456789;
const LON = 3.379123456;

describe('live socket log redaction (plan §5.2)', () => {
  it('keeps socket tokens and caller locations out of the log', () => {
    const { log, text } = bufferedLogger();
    log.info({ token: TOKEN, userId: 'user-kept' }, 'top-level token');
    log.info({ message: { type: 'auth', token: TOKEN } }, 'auth message');
    log.info({ msg: { data: { token: TOKEN } } }, 'two levels down');
    log.info({ lat: LAT, lon: LON }, 'top-level fix');
    log.info({ message: { type: 'location', lat: LAT, lon: LON } }, 'location message');
    log.info({ a: { b: { lat: LAT, lon: LON } } }, 'two levels down');
    log.info({ location: { lat: LAT, lon: LON }, body: { location: { lat: LAT } } }, 'location objects');
    log.info({ row: { live_lat: LAT, live_lon: LON }, live_lat: LAT }, 'submission row');
    const out = text();
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(String(LAT));
    expect(out).not.toContain(String(LON));
    expect(out).toContain('user-kept');
  });
});
