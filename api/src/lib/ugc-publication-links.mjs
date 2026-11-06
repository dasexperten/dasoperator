// Exact public publication hosts/paths only: a profile, redirect or lookalike
// domain is not a publication. The sender is discovery provenance, not authorship.
export function publicationLink(raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, ''), path = u.pathname;
  let platform, code, kind = 'post', canonical;
  let m;
  if (['instagram.com','instagr.am'].includes(host) && (m=path.match(/^\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{6,})\/?$/))) {
    platform='instagram'; code=m[2]; kind=m[1]==='p'?'post':'video'; canonical=`https://www.instagram.com/${m[1]==='p'?'p':'reel'}/${code}/`;
  } else if (host==='tiktok.com' && (m=path.match(/^\/@([A-Za-z0-9_.]+)\/video\/(\d+)\/?$/))) {
    platform='tiktok';code=m[2];kind='video';canonical=`https://www.tiktok.com/@${m[1]}/video/${code}`;
  } else if (['t.me','telegram.me'].includes(host) && (m=path.match(/^\/([A-Za-z][A-Za-z0-9_]{3,})\/(\d+)\/?$/))) {
    platform='telegram';code=`${m[1].toLowerCase()}/${m[2]}`;canonical=`https://t.me/${code}`;
  } else if (['vk.com','vkvideo.ru'].includes(host) && (m=path.match(/^\/(wall|video|clip)(-?\d+_\d+)\/?$/))) {
    platform='vk';code=`${m[1]}${m[2]}`;kind=m[1]==='wall'?'post':'video';canonical=`https://vk.com/${code}`;
  } else if (host==='facebook.com' && (m=path.match(/^\/(reel\/\d+|[A-Za-z0-9.]+\/posts\/[A-Za-z0-9]+)\/?$/))) {
    platform='facebook';code=m[1];kind=code.startsWith('reel/')?'video':'post';canonical=`https://www.facebook.com/${code}/`;
  } else if (['youtube.com','youtu.be'].includes(host)) {
    code=host==='youtu.be'?path.slice(1):path==='/watch'?u.searchParams.get('v'):path.match(/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
    if (!/^[A-Za-z0-9_-]{11}$/.test(code??'')) return null;
    platform='youtube';kind='video';canonical=`https://www.youtube.com/watch?v=${code}`;
  } else return null;
  return {platform,code,kind,url:canonical,key:`${platform}:${code}`};
}
export function publicationLinks(text) {
  const links=new Map();
  for(const token of String(text??'').matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const link=publicationLink(token[0].replace(/[),.!?;]+$/,''));
    if(link) links.set(link.key,link);
  }
  return [...links.values()];
}
export const contentReviewKey=(creatorId,key)=>`ugc_content_review:${creatorId}:${key}`;
