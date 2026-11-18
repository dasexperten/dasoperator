import { publicationLink } from './ugc-publication-links.mjs';
export function contentEngagement(row,followers,profilePlatform) {
  if(row.product_status!=='identified' || publicationLink(row.content_url)?.platform!==profilePlatform) return null;
  // Owner 2026-11-18: ER is counted only once the reel's views are visible.
  if(row.views==null) return null;
  if(!followers || followers<50 || (row.likes==null&&row.comments==null)) return null;
  return Math.round(((Number(row.likes??0)+Number(row.comments??0))/followers)*1000)/10;
}
