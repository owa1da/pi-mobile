// A sequential poller: one run at a time, the next scheduled after the previous finishes.

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PollerOptions {
  intervalMs: number;
  /** Return a number to override the delay before the next run (0 = immediately). */
  run: () => Promise<number | void> | number | void;
  timers?: Timers;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** Run now (or right after the current run finishes). */
  kick(): void;
  readonly running: boolean;
}

export function createPoller(options: PollerOptions): Poller {
  const timers = options.timers ?? realTimers;
  let active = false;
  let inFlight = false;
  let rerun = false;
  let generation = 0;
  let timer: unknown = null;

  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const schedule = (ms: number) => {
    clear();
    const gen = generation;
    timer = timers.setTimeout(
      () => {
        timer = null;
        if (gen === generation) void tick();
      },
      Math.max(0, ms),
    );
  };

  async function tick(): Promise<void> {
    if (!active) return;
    if (inFlight) {
      rerun = true;
      return;
    }
    inFlight = true;
    const gen = generation;
    let next: number | void = undefined;
    try {
      next = await options.run();
    } catch {
      next = undefined;
    }
    inFlight = false;
    if (!active || gen !== generation) {
      // Restarted while this run was in flight: the new generation schedules itself.
      if (active && rerun) {
        rerun = false;
        schedule(0);
      }
      return;
    }
    const delay = rerun ? 0 : (next ?? options.intervalMs);
    rerun = false;
    schedule(delay);
  }

  return {
    start() {
      if (active) return;
      active = true;
      generation += 1;
      if (inFlight) rerun = true;
      else schedule(0);
    },
    stop() {
      active = false;
      generation += 1;
      rerun = false;
      clear();
    },
    kick() {
      if (!active) return;
      if (inFlight) rerun = true;
      else schedule(0);
    },
    get running() {
      return active;
    },
  };
}
