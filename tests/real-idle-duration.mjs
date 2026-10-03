// A timer callback can arrive before its requested millisecond boundary.
// Keep observing until both actual wall and monotonic clocks meet the original
// 60.5-second gate; this never shortens the required observation window.
export const MINIMUM_IDLE_MS = 60_500;
export async function waitForMinimumIdle(wait) {
  const wallStart = Date.now(), monotonicStart = performance.now();
  let elapsedMs = 0, monotonicElapsedMs = 0, waits = 0;
  while (elapsedMs < MINIMUM_IDLE_MS || monotonicElapsedMs < MINIMUM_IDLE_MS) {
    await wait(Math.max(1, Math.ceil(Math.max(
      MINIMUM_IDLE_MS - elapsedMs, MINIMUM_IDLE_MS - monotonicElapsedMs,
    ))));
    waits++;
    elapsedMs = Date.now() - wallStart;
    monotonicElapsedMs = performance.now() - monotonicStart;
    if (monotonicElapsedMs > MINIMUM_IDLE_MS + 5_000 && elapsedMs < MINIMUM_IDLE_MS)
      throw new Error(`Idle wall clock did not reach ${MINIMUM_IDLE_MS}ms: wall=${elapsedMs}, monotonic=${monotonicElapsedMs}`);
  }
  return { elapsedMs, monotonicElapsedMs, minimumMs: MINIMUM_IDLE_MS, waits };
}
