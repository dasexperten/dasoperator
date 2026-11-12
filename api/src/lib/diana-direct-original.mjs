// Read an Instagram conversation for the current execution only. This module
// deliberately has no database, bucket, logging, or durable workflow writes.
const PAGE = '1697038263872226';
const BRAND = '17841466350261166';
const GRAPH = 'https://graph.facebook.com/v21.0/';
const FIELDS = 'id,created_time,from,message,attachments{mime_type,image_data,video_data,file_url},shares{link},is_unsupported';

export async function readDirectOriginal({conversationId, messageId, token, fetchImpl = fetch}) {
  if (!conversationId || !messageId || !token) throw Error('direct_identity_or_token_missing');
  async function graph(path, key) {
    const response = await fetchImpl(GRAPH + path, {
      headers: {Authorization: `Bearer ${key}`}, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error(`direct_original_http_${response.status}`);
    const body = await response.json();
    if (body.error) throw Error('direct_original_api_error');
    return body;
  }
  const page = await graph(`${PAGE}?fields=access_token`, token);
  if (!page.access_token) throw Error('direct_page_token_missing');
  const items = [];
  const cursors = new Set();
  let after = '';
  while (true) {
    const response = await graph(`${encodeURIComponent(conversationId)}/messages?fields=${FIELDS}&limit=100${after ? '&after=' + encodeURIComponent(after) : ''}`, page.access_token);
    if (!Array.isArray(response.data)) throw Error('direct_original_invalid');
    items.push(...response.data);
    if (!response.paging?.next) break;
    const next = response.paging?.cursors?.after;
    if (!next || cursors.has(next) || !response.data.length) throw Error('direct_original_incomplete');
    cursors.add(next); after = next;
  }
  // Owner 2026-11-12 (svetlanakogai2018): the chat list can show a screenshot as an empty
  // «unsupported» message while the same message, asked for by its own id, carries the picture.
  // Ask again for the newest empty incoming messages so Diana reads the cart instead of «сумма?».
  let asked = 0;
  for (const item of items) {
    if (asked >= 6) break;
    if ([PAGE, BRAND].includes(String(item?.from?.id ?? ''))) continue;
    if (String(item?.message ?? '').trim() || item?.attachments?.data?.length || item?.shares?.data?.length || !item?.id) continue;
    asked++;
    try {
      const one = await graph(`${encodeURIComponent(item.id)}?fields=attachments{mime_type,image_data,video_data,file_url}`, page.access_token);
      if (Array.isArray(one.attachments?.data) && one.attachments.data.length) { item.attachments = one.attachments; delete item.is_unsupported; }
    } catch { /* the list answer stands */ }
  }
  const latest = items[0];
  // 2026-11-12 (diljon_recepti): the blogger deleted the chat or her account — Meta returns no
  // messages. That is not a failure to retry for ever; there is nothing left to answer.
  if (!items.length) return {status:'superseded', gone:true};
  if (!latest?.id || !latest?.from?.id) throw Error('direct_original_identity_missing');
  if (String(latest.id) !== String(messageId) || [PAGE, BRAND].includes(String(latest.from.id))) return {status:'superseded'};
  return {status:'ready', conversationId:String(conversationId), messageId:String(messageId), messages:items.reverse()};
}
