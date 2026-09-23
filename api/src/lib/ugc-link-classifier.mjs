export const UGC_LINK_STATUSES = ['active', 'missing', 'restricted', 'unknown', 'invalid'];

const RESTRICTED_PATH = /\/(?:accounts\/login|login|challenge|checkpoint|sorry)(?:\/|\?|$)/i;
const RESTRICTED_BODY = /(?:log in to instagram|challenge_required|verify you are human|security check required|unusual traffic|captcha challenge|access denied)/i;
const AMBIGUOUS_UNAVAILABLE_BODY = /(?:page not found|page isn['’]t available|content isn['’]t available|this video is unavailable|video unavailable|post is unavailable)/i;

export function isSafePublicHttpUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (/^(?:0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return false;
    const private172 = /^172\.(\d{1,3})\./.exec(host);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export function classifyUgcLink(httpStatus, finalUrl, bodySnippet = '') {
  // Optional future JEV review belongs only after this deterministic pass, for
  // ambiguous 2xx HTML. It must never override 404/410 or turn a blocked page
  // into "missing"; JEV is retrieval/ranking, not the reachability probe.
  if (httpStatus === 404 || httpStatus === 410) return 'missing';
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) return 'restricted';
  if (httpStatus >= 500 || httpStatus <= 0) return 'unknown';
  if (RESTRICTED_PATH.test(finalUrl) || RESTRICTED_BODY.test(bodySnippet)) return 'restricted';
  if (AMBIGUOUS_UNAVAILABLE_BODY.test(bodySnippet)) return 'unknown';
  if (httpStatus >= 200 && httpStatus < 400) return 'active';
  return 'unknown';
}
