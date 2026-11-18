export function contentConfirmed(item) { return item?.product_status==='identified'; }
// Owner 2026-11-19: «grey can be only the reels that are not passing the link check». The colour
// follows the link alone; whether the product is confirmed no longer greys a working reel.
export function contentState(item) {
  return ['missing','restricted','invalid'].includes(item?.link_status)?'dead':'live';
}
export function publicationNetwork(href) {
  let host;try{host=new URL(href).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}
  return ({'instagram.com':'instagram','instagr.am':'instagram','tiktok.com':'tiktok','vt.tiktok.com':'tiktok','vm.tiktok.com':'tiktok','youtube.com':'youtube','youtu.be':'youtube','vk.com':'vk','vkvideo.ru':'vk','t.me':'telegram','telegram.me':'telegram','facebook.com':'facebook','fb.watch':'facebook'})[host]??'';
}
