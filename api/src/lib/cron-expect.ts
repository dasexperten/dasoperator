// How many times a Cloudflare cron should have fired in a UTC window.
// Five fields: minute hour day-of-month month day-of-week (0 or 7 = Sunday).
// Supports *, n, a-b, lists, and /step on * or a range. When both day fields are
// restricted, a day matches if EITHER matches (standard cron behaviour).

type Field = { any: boolean; set: Set<number> };

function parseField(src: string, min: number, max: number): Field {
  if (src === '*') return { any: true, set: new Set() };
  const set = new Set<number>();
  for (const part of src.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = stepRaw ? max : lo;
    }
    if (![lo, hi, step].every(Number.isFinite) || step < 1) throw new Error(`bad cron field "${src}"`);
    for (let v = lo; v <= hi; v += step) set.add(v === 7 && max === 7 ? 0 : v);
  }
  return { any: false, set };
}

export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  return {
    minute: parseField(f[0]!, 0, 59),
    hour: parseField(f[1]!, 0, 23),
    dom: parseField(f[2]!, 1, 31),
    month: parseField(f[3]!, 1, 12),
    dow: parseField(f[4]!, 0, 7),
  };
}

const has = (f: Field, v: number) => f.any || f.set.has(v);

export function matches(c: Cron, d: Date): boolean {
  if (!has(c.minute, d.getUTCMinutes()) || !has(c.hour, d.getUTCHours()) || !has(c.month, d.getUTCMonth() + 1)) return false;
  const domOk = has(c.dom, d.getUTCDate());
  const dowOk = has(c.dow, d.getUTCDay());
  if (!c.dom.any && !c.dow.any) return domOk || dowOk;
  return domOk && dowOk;
}

/** Fire times in [from, to), minute resolution. */
export function expectedFires(expr: string, from: Date, to: Date): Date[] {
  const c = parseCron(expr);
  const out: Date[] = [];
  const t = new Date(from);
  t.setUTCSeconds(0, 0);
  if (t < from) t.setUTCMinutes(t.getUTCMinutes() + 1);
  for (; t < to; t.setUTCMinutes(t.getUTCMinutes() + 1)) if (matches(c, t)) out.push(new Date(t));
  return out;
}
