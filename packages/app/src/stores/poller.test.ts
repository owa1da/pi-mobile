import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoller } from "./poller";

describe("createPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs immediately on start, then every interval, and stops", async () => {
    const run = vi.fn(() => undefined);
    const poller = createPoller({ intervalMs: 2000, run });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(poller.running).toBe(false);
  });

  it("never overlaps runs and schedules after a slow run finishes", async () => {
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      active -= 1;
    });
    const poller = createPoller({ intervalMs: 1000, run });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.kick();
    await vi.advanceTimersByTimeAsync(5001);
    // the kick during the run reruns right after it, not after the 1 s interval
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000 + 1000);
    expect(maxActive).toBe(1);
    poller.stop();
  });

  it("uses the delay a run returns (0 = again right away)", async () => {
    const delays = [0, 0, 500];
    const run = vi.fn(() => delays.shift());
    const poller = createPoller({ intervalMs: 5000, run });
    poller.start();
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(499);
    expect(run).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(4000);
    expect(run).toHaveBeenCalledTimes(4);
    poller.stop();
  });

  it("keeps polling after a run throws", async () => {
    const run = vi.fn(() => {
      throw new Error("boom");
    });
    const poller = createPoller({ intervalMs: 1000, run });
    poller.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it("kick does nothing while stopped", async () => {
    const run = vi.fn();
    const poller = createPoller({ intervalMs: 1000, run });
    poller.kick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
