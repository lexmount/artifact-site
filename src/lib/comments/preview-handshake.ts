/** Keep slow loads alive; completed documents get a bounded acknowledgement window. */
export function startPreviewHandshake(send: () => void, expectedPath: string | null = null, onUnavailable?: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let attempts = 0;
  let loaded = false;
  const stop = () => { stopped = true; clearTimeout(timer); };
  const ping = () => {
    if (stopped) return;
    if (loaded && attempts >= 8) { stop(); onUnavailable?.(); return; }
    send();
    timer = setTimeout(ping, ++attempts < 8 || loaded ? 300 : 1000);
  };
  ping();
  return {
    stop,
    markLoaded() { loaded = true; },
    accept(path: string | null) {
      // WindowProxy survives navigation: the old document may answer the new channel.
      if (stopped || (expectedPath !== null && path !== expectedPath)) return false;
      stop();
      return true;
    },
  };
}
