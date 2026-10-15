// Adaptive check cadence (Owner 2026-10-15, law DH-LAW-261015-01):
// activity on a check → next check in 3 minutes; the first idle check after
// that → 15 minutes; idle again → 30 minutes, and every 30 minutes until
// activity returns, which restarts the loop at 3.
export const ACTIVE_MIN = 3;
export const IDLE_FIRST_MIN = 15;
export const IDLE_LONG_MIN = 30;

/** idle = idle checks in a row before this one. */
export function nextCadence(activity, idle) {
  if (activity) return { delayMin: ACTIVE_MIN, idle: 0 };
  const prev = Number.isInteger(idle) && idle > 0 ? idle : 0;
  return { delayMin: prev === 0 ? IDLE_FIRST_MIN : IDLE_LONG_MIN, idle: prev + 1 };
}

/** Is the lane due at `now` (ms)? A lane with no stored state is due. */
export function laneDue(state, now) {
  return !state || !Number.isFinite(state.next_at) || now >= state.next_at;
}

/** Stored state after a check that ran at `now`. */
export function afterCheck(state, activity, now) {
  const c = nextCadence(activity, state?.idle ?? 0);
  return { next_at: now + c.delayMin * 60_000, idle: c.idle, last_at: now, last_activity: !!activity, delay_min: c.delayMin };
}
