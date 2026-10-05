import { useEffect, useState } from "react";

interface Ticker {
  listeners: Set<(now: number) => void>;
  timer: ReturnType<typeof setInterval>;
}

// Like the session glyphs, clocks at the same cadence share a timer, only while subscribed.
const tickers = new Map<number, Ticker>();

export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    let ticker = tickers.get(intervalMs);
    if (!ticker) {
      const listeners = new Set<(now: number) => void>();
      const timer = setInterval(() => {
        const next = Date.now();
        for (const listener of listeners) listener(next);
      }, intervalMs);
      ticker = { listeners, timer };
      tickers.set(intervalMs, ticker);
    }
    ticker.listeners.add(setNow);
    return () => {
      ticker.listeners.delete(setNow);
      if (ticker.listeners.size === 0) {
        clearInterval(ticker.timer);
        tickers.delete(intervalMs);
      }
    };
  }, [enabled, intervalMs]);
  return now;
}
