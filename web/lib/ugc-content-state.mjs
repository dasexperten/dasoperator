export function contentConfirmed(item) { return item?.product_status==='identified'; }
export function contentState(item) {
  if(!contentConfirmed(item)) return 'pending';
  return ['missing','restricted','invalid'].includes(item.link_status)?'dead':'live';
}
export function publicationNetwork(href) {
  let host;try{host=new URL(href).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}
  return ({'instagram.com':'instagram','instagr.am':'instagram','tiktok.com':'tiktok','vt.tiktok.com':'tiktok','vm.tiktok.com':'tiktok','youtube.com':'youtube','youtu.be':'youtube','vk.com':'vk','vkvideo.ru':'vk','t.me':'telegram','telegram.me':'telegram','facebook.com':'facebook','fb.watch':'facebook'})[host]??'';
}
