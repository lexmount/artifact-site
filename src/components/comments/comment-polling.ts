/** Compare response content, not fetch timestamps, to reduce idle list traffic. */
export function createCommentCadence() {
  let previous: string | undefined;
  let delay = 10000;
  return {
    accept(snapshot: string, interactive = false) {
      delay = interactive || snapshot !== previous ? 10000 : Math.min(30000, delay + 10000);
      previous = snapshot;
      return delay;
    },
  };
}

/** A completion-based timer: hidden tabs have no timer, and wake events coalesce. */
export function startVisiblePolling(
  run: (initial: boolean) => Promise<void>,
  delay: (wake?: boolean) => number,
  visibility: EventTarget & { readonly hidden: boolean } = document,
  focus: EventTarget = window,
) {
  let stopped = false;
  let running = false;
  let initial = true;
  let lastStarted = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped && !visibility.hidden) timer = setTimeout(() => void tick(), ms);
  };
  const tick = async () => {
    if (stopped || visibility.hidden || running) return;
    running = true;
    lastStarted = Date.now();
    const first = initial;
    initial = false;
    try { await run(first); }
    catch { /* The caller owns error reporting and the retry floor. Keep the loop alive. */ }
    finally { running = false; schedule(delay()); }
  };
  const wake = () => {
    clearTimeout(timer);
    if (!running) schedule(Math.max(delay(true), 1000 - (Date.now() - lastStarted), 0));
  };
  const focused = () => { if (Date.now() - lastStarted >= 10000) wake(); };
  visibility.addEventListener("visibilitychange", wake);
  focus.addEventListener("focus", focused);
  schedule(0);
  return () => {
    stopped = true;
    clearTimeout(timer);
    visibility.removeEventListener("visibilitychange", wake);
    focus.removeEventListener("focus", focused);
  };
}
