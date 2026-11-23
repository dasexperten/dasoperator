// Owner 2026-11-07: single opens the source; each double-click updates the Dieter selection.
export function reelClickController({ open, queue, schedule = setTimeout, cancel = clearTimeout, delay = 600 }) {
  let timer = null, busy = false, disposed = false;
  return {
    click(detail) {
      if (disposed) return;
      if (timer !== null) { cancel(timer); timer = null; }
      if (detail >= 2) {
        // Browsers can count consecutive double-clicks as 1, 2, 3, 4.
        if (detail % 2 === 0 && !busy) {
          busy = true;
          Promise.resolve().then(queue).then(
            () => { busy = false; },
            () => { busy = false; },
          );
        }
        return;
      }
      timer = schedule(() => { timer = null; if (!disposed) open(); }, delay);
    },
    dispose() { disposed = true; if (timer !== null) cancel(timer); timer = null; },
  };
}
