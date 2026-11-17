/** All time in the relay comes from a Clock, so time-based rules are testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Test clock. Starts at a fixed instant and only moves when told to. */
export class FakeClock implements Clock {
  private ms: number;
  constructor(start: Date | string = '2026-11-17T12:00:00.000Z') {
    this.ms = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  advanceSeconds(s: number): void {
    this.advance(s * 1000);
  }
  advanceMinutes(m: number): void {
    this.advance(m * 60_000);
  }
  set(at: Date | string): void {
    this.ms = new Date(at).getTime();
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
