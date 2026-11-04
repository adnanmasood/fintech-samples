/**
 * A clock seam. Every timestamp in the system goes through this so tests can
 * run schedules and cooldowns deterministically instead of sleeping.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export class FakeClock implements Clock {
  constructor(private current: number = 0) {}
  now(): number {
    return this.current;
  }
  set(ms: number): void {
    this.current = ms;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
