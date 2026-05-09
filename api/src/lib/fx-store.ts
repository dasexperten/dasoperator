// =============================================================================
// FX KV cache layer
//
// Keys:
//   fx:{date}     → JSON FxSnapshot for that date
//   fx:latest     → string pointer to most recent successfully cached date
//
// Read path: getRatesFor(date)
//   1. Read fx:{date} from KV
//   2. If miss — fetch CBR live, cache, return
//   3. If CBR unreachable — return null (caller decides what to do)
//
// Write path: storeRates(snapshot)
//   1. Write fx:{snapshot.date}
//   2. If snapshot.date >= current latest — update fx:latest pointer
// =============================================================================

import type { FxSnapshot } from './fx-cbr';
import { refreshFxFromCbr } from './fx-cbr';

const KEY_PREFIX = 'fx:';
const LATEST_KEY = 'fx:latest';

export async function readSnapshot(
  fx: KVNamespace,
  date: string
): Promise<FxSnapshot | null> {
  const raw = await fx.get(`${KEY_PREFIX}${date}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FxSnapshot;
  } catch {
    return null;
  }
}

export async function readLatestPointer(fx: KVNamespace): Promise<string | null> {
  return fx.get(LATEST_KEY);
}

export async function storeSnapshot(
  fx: KVNamespace,
  snapshot: FxSnapshot
): Promise<void> {
  await fx.put(`${KEY_PREFIX}${snapshot.date}`, JSON.stringify(snapshot));

  const currentLatest = await readLatestPointer(fx);
  if (!currentLatest || snapshot.date > currentLatest) {
    await fx.put(LATEST_KEY, snapshot.date);
  }
}

// Get rates for a date with cache-through semantics.
// Returns null if both KV and CBR fail.
export async function getRatesFor(
  fx: KVNamespace,
  date: string
): Promise<FxSnapshot | null> {
  const cached = await readSnapshot(fx, date);
  if (cached) return cached;

  const fresh = await refreshFxFromCbr(date);
  if (!fresh) return null;

  await storeSnapshot(fx, fresh);
  return fresh;
}
