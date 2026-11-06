import { publicationLink } from './ugc-publication-links.mjs';
export function contentEngagement(row,followers,profilePlatform) {
  if(row.product_status!=='identified' || publicationLink(row.content_url)?.platform!==profilePlatform) return null;
  if(!followers || followers<50 || (row.likes==null&&row.comments==null)) return null;
  return Math.round(((Number(row.likes??0)+Number(row.comments??0))/followers)*1000)/10;
}
