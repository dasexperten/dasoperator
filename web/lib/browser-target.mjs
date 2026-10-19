// Owner 2026-10-19: on a computer the queue button knows itself whether it is the PC or the Mac;
// on a phone or tablet it offers both.
export function deviceTargets(ua = '', platform = '', maxTouch = 0) {
  const text = `${platform} ${ua}`;
  if (/Android|iPhone|iPod|Mobile/i.test(ua)) return ['pc', 'mac'];
  if (/iPad/i.test(ua) || (/Mac/i.test(text) && maxTouch > 1)) return ['pc', 'mac'];
  if (/Win/i.test(text)) return ['pc'];
  if (/Mac/i.test(text)) return ['mac'];
  return ['pc', 'mac'];
}
