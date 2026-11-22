import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { m4a } from './fixtures.js';

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

const AUDIO = Buffer.from('SECRET-AUDIO-0123456789abcdef');
const BASE64 = AUDIO.toString('base64');

describe('recording log redaction (plan §4.4)', () => {
  it("keeps Core's Data field and the audio out of the log at every depth a log call uses", () => {
    const { log, text } = bufferedLogger();
    log.info({ Data: BASE64, kept: 'kept-1' }, 'core body');
    log.info({ body: { CallId: '1', Data: BASE64 }, kept: 'kept-2' }, 'core request');
    log.info({ request: { body: { Data: BASE64 } }, kept: 'kept-3' }, 'core request, nested');
    log.info({ bytes: AUDIO, kept: 'kept-4' }, 'row bytes');
    log.info({ recording: { bytes: AUDIO, size: 29 }, kept: 'kept-5' }, 'row');
    log.info({ audio: BASE64, kept: 'kept-6' }, 'audio');
    log.info({ req: { body: AUDIO } }, 'request body');

    const out = text();
    expect(out).not.toContain(BASE64);
    expect(out).not.toContain('SECRET-AUDIO');
    expect(out).not.toContain(AUDIO.toString('hex'));
    for (const k of ['kept-1', 'kept-2', 'kept-3', 'kept-4', 'kept-5', 'kept-6']) expect(out).toContain(k);
    expect(out).toContain('[redacted]');
  });

  it('keeps a whole uploaded body out of the log wherever it is logged', () => {
    const { log, text } = bufferedLogger();
    const body = m4a('UPLOAD-MARKER', 400);
    log.info({ body }, 'body');
    log.info({ req: { body } }, 'req');
    log.error({ err: { body } }, 'err');
    expect(text()).not.toContain('UPLOAD-MARKER');
    expect(text()).not.toContain(body.toString('base64').slice(8, 40));
  });
});
