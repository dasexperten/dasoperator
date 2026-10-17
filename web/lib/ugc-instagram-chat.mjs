// ig.me resolves the username to the existing Direct thread in the signed-in
// Instagram account. Verified in Chrome for the dasexperten account.
export function instagramChatHref(profiles = []) {
  for (const platform of ['instagram', 'other']) {
    for (const profile of profiles.filter(p => p.platform === platform)) {
      const handle = String(profile.handle ?? '').replace(/^@/, '').trim();
      if (/^[A-Za-z0-9_][A-Za-z0-9_.]{0,29}$/.test(handle)) return `https://ig.me/m/${handle}`;
    }
  }
  return null;
}
