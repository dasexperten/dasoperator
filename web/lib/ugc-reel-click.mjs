// Owner 2026-11-07: single opens the source; double selects it for Dieter.
export function reelClickController({ open, queue, schedule = setTimeout, cancel = clearTimeout, delay = 600 }) {
  let timer = null, queued = false, disposed = false;
  return {
    click(detail) {
      if (disposed) return;
      if (timer !== null) { cancel(timer); timer = null; }
      if (detail >= 2) {
        if (!queued) {
          queued = true;
          Promise.resolve().then(queue).then((ok) => { if (!ok) queued = false; }, () => { queued = false; });
        }
        return;
      }
      timer = schedule(() => { timer = null; if (!disposed) open(); }, delay);
    },
    dispose() { disposed = true; if (timer !== null) cancel(timer); timer = null; },
  };
}
