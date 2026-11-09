// Owner 2026-11-09: direct VK API upload and public post verified; preserve saved scope.
export const REEL_SCOPE_VERSION = 'ugc-select-vk-2026-11-09';
export const ACTIVE_REEL_DESTINATIONS = Object.freeze(['instagram','threads','youtube','facebook','vk']);
export const DEFERRED_REEL_DESTINATIONS = Object.freeze(['tiktok','rutube']);
export function reelScope(job = {}) {
  const saved = typeof job.required_destinations === 'string' ? JSON.parse(job.required_destinations) : job.required_destinations;
  if (saved != null && !Array.isArray(saved)) throw new Error('invalid_saved_destinations');
  const original = saved ?? [];
  if (original.some(x=>![...ACTIVE_REEL_DESTINATIONS,...DEFERRED_REEL_DESTINATIONS].includes(x))) throw new Error('unknown_saved_destination');
  const baseline = original.length ? original : ACTIVE_REEL_DESTINATIONS;
  return { version: REEL_SCOPE_VERSION, active: baseline.filter(x=>ACTIVE_REEL_DESTINATIONS.includes(x)),
    deferred: baseline.filter(x=>DEFERRED_REEL_DESTINATIONS.includes(x)), original_required_destinations: [...original],
    model_policy: { codex: 'gpt-6.1-terra', higher_model_fallback: false },
    accounts: { instagram:'dasexperten',threads:'dasexperten',youtube_channel_id:'UCCL3d3tuxNJSYQgNRGw1uRw',facebook_page_id:'1697038263872226',vk_community_id:'229095983' } };
}
export function reelJobScopeView(job) { return {...job, destination_scope:reelScope(job), active_destinations:reelScope(job).active, deferred_destinations:reelScope(job).deferred}; }
// Owner 2026-11-07: minimal re-edit of an explicitly selected creator reel.
export const REEL_STATUSES = new Set(['queued', 'working', 'published']);
export function reelPublicationProof(value, sourceUrl) {
  if (!Array.isArray(value) || !value.length) return null;
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    let url;
    try { url = new URL(String(item.url ?? '')); } catch { return null; }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const platform = String(item.platform ?? '');
    const path = url.pathname;
    const valid = platform === 'instagram' ? host === 'instagram.com' && /^\/(?:reel|p)\/[A-Za-z0-9_-]+\/?$/.test(path)
      : platform === 'threads' ? ['threads.net', 'threads.com'].includes(host) && /^\/@[^/]+\/post\/[A-Za-z0-9_-]+\/?$/.test(path)
      : platform === 'vk' ? ['vk.com', 'vk.ru', 'vkvideo.ru'].includes(host) && /^\/(?:wall|video|clip)-?\d+_\d+\/?$/.test(path)
      : platform === 'youtube' ? ((['youtube.com','m.youtube.com'].includes(host) && (/^\/shorts\/[A-Za-z0-9_-]{11}\/?$/.test(path) || (path === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get('v') ?? '')))) || (host === 'youtu.be' && /^\/[A-Za-z0-9_-]{11}\/?$/.test(path)))
      : platform === 'facebook' ? host === 'facebook.com' && (/^\/reel\/\d+\/?$/.test(path) || /^\/\d+\/videos\/\d+\/?$/.test(path))
      : platform === 'rutube' ? host === 'rutube.ru' && /^\/(?:video|shorts)\/[a-fA-F0-9]{32}\/?$/.test(path)
      : platform === 'tiktok' ? host === 'tiktok.com' && /^\/@[A-Za-z0-9._]+\/video\/\d+\/?$/.test(path) && path.split('/')[1]?.slice(1).toLowerCase() === String(item.account ?? '').replace(/^@/,'').trim().toLowerCase() : false;
    const coauth = platform === 'instagram' && item.instagram_placement === 'accepted_coauth';
    if (coauth && (String(item.account).replace(/^@/,'') !== 'dasexperten' || item.instagram_collaborator_account_id !== '17841466350261166' || !/^\d{5,40}$/.test(String(item.instagram_media_id ?? '')))) return null;
    const checked = Date.parse(String(item.verified_at ?? ''));
    const evidence = String(item.evidence ?? '').trim();
    const account = String(item.account ?? '').trim();
    if (!valid || url.protocol !== 'https:' || url.username || url.password || url.port || !evidence || !account ||
      !Number.isFinite(checked) || checked > Date.now() + 60_000 || item.verified !== true) return null;
    const youtubeId = platform === 'youtube' && path === '/watch' ? url.searchParams.get('v') : null;
    url.search = ''; if (youtubeId) url.searchParams.set('v', youtubeId); url.hash = '';
    let source;
    try { source = new URL(String(sourceUrl)); } catch { source = null; }
    if (!coauth && source && source.hostname.toLowerCase().replace(/^www\./, '') === host && source.pathname.replace(/\/$/, '') === path.replace(/\/$/, '') && (platform !== 'youtube' || path !== '/watch' || source.searchParams.get('v') === youtubeId)) return null;
    if (source && platform === 'youtube' && ['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(source.hostname.toLowerCase()) && publicationKey({platform,url:source.href}) === publicationKey({platform,url:url.href})) return null;
    if (source && platform === 'vk' && ['vk.com','www.vk.com','vk.ru','www.vk.ru','vkvideo.ru','www.vkvideo.ru'].includes(source.hostname.toLowerCase()) && publicationKey({platform,url:source.href}) === publicationKey({platform,url:url.href})) return null;
    if (source && platform === 'facebook' && ['facebook.com','www.facebook.com'].includes(source.hostname.toLowerCase()) && publicationKey({platform,url:source.href}) === publicationKey({platform,url:url.href})) return null;
    if (source && platform === 'rutube' && ['rutube.ru','www.rutube.ru'].includes(source.hostname.toLowerCase()) && publicationKey({platform,url:source.href}) === publicationKey({platform,url:url.href})) return null;
    // The same Instagram media shortcode is the original even if /reel becomes /p.
    if (!coauth && source && platform === 'instagram' && /^(?:www\.)?instagram\.com$/.test(source.hostname) && source.pathname.split('/').filter(Boolean).at(-1) === path.split('/').filter(Boolean).at(-1)) return null;
    result.push({ platform, url: url.href, account: account.slice(0, 160), verified: true,
      verified_at: new Date(checked).toISOString(), evidence: evidence.slice(0, 2000), ...(coauth ? {instagram_placement:'accepted_coauth',instagram_media_id:String(item.instagram_media_id),instagram_collaborator_account_id:item.instagram_collaborator_account_id} : {}) });
  }
  return result;
}

export function reelTaskText(job, origin) {
  const id = encodeURIComponent(job.content_id);
  const scope = reelScope(job);
  const required = scope.active;
  return `Дитер: diter-ugc-round / UGC Selection (UGC-селекция). РОВНО ОДИН уже принятый жёлтый пост: content_id=${job.content_id}; claim_id=${job.claim_id}; источник ${job.content_url}; контакт @${job.handle} (отправитель ссылки, не автоматически автор). Не ищи и не выбирай другой ролик, не трогай зелёные задания. Требуемые публичные площадки: ${JSON.stringify(required)}; версия ${scope.version}. Отложенные назначения: ${JSON.stringify(scope.deferred)}; автоматически не выполнять до подтверждённого подключения. Исторический scope ${JSON.stringify(scope.original_required_destinations)} не стирать. Модель операции: Codex gpt-6.1-terra, без более высокой модели/fallback; чистые API-вызовы без модели.
1. Источник может быть с ЛЮБОЙ площадки, Instagram permalink не обязателен. Для Instagram-оригинала или установленного Instagram-эквивалента проверяй соавторство: полный официальный collaborative_media (принятые соавторства) и collaboration_invites (ожидающие), затем собственный /media. Точное совпадение источника и принятое соавторство ИЛИ уже существующий собственный пост => сохранить доказательство, НЕ публиковать дубль. Pending, ошибка API, неизвестный mediaID или неполная пагинация не являются отсутствием: остановить только Instagram, остальные активные назначения можно выполнить. Для внешнего источника без Instagram-эквивалента coauth=not_applicable, не выдуманное absent; отсутствие Instagram permalink не блокирует публикацию. Используй docs/INSTAGRAM_COLLAB_CHECK.md и jobs/diter-ugc-round/instagram_api.py. Сначала проверь уже существующие публикации именно этого ролика на наших подтверждённых аккаунтах. Сохрани проверенные прямые ссылки и доказательства. Уже опубликованное повторно не загружай. ERP proofs: ${job.publications ?? '[]'}.
2. Default alarm input is the exact selected complete original in company Google Drive ugc-videos/originals (folder13fAh0oFKq_PCUkL0iG8WIOpHfPN8vM39, dasexperten@gmail.com; jobs/diter-ugc-round/drive-folders.json). Match source/creator/SHA/provider ID; never guess by a common filename. Only if absent, download once: YouTube via current yt-dlp[default]+EJS and supported JavaScript runtime; Instagram/Facebook/VK/TikTok via official Apify. Empty or non-video HTML means verified company Jev fallback. Always select the maximum native source quality for ALL videos, with no arbitrary resolution or bitrate cap. Inspect all source formats and selected dimensions; height<=720 wrongly rejects portrait720x1280. Upload the highest quality each destination accepts, preserving resolution/fps/audio. Remux without reencoding when possible; transcode only for a verified compatibility need; upscaling is not a higher quality source. Check full decode, dimensions/fps, duration, sound, original author and product; consult Maya. Save the unchanged raw file in originals and verify Drive file ID/size/parent BEFORE distribution; record source, Drive ID and SHA. Reuse for all assigned platforms. Filename: accountname_YYYY-MM-DD.mp4 when account known, date of archive save in Yerevan; otherwise source_YYYY-MM-DD.mp4. Same-day different videos use _02 suffix, never overwrite. Keep source IDs/SHA in job metadata rather than the display name.
3. The default alarm distributes the complete original, with no editorial cuts or automatic translation. Separate instructions request translations (ugc-videos/translations,1L7EYdY2rYxDZSe3JsRMOPC8WaVYLPMxd) or edits (ugc-videos/edits,1_XJepc1U3bonX7RiFKdGifukY4vfnIfm). Keep matching basenames across these folders; never overwrite originals. Technical compatibility copies also go in edits and change no scenes/speech/product/person. Product splitting/unpacking rules and editorial reviews apply only when an edit is separately instructed.
4. Не переписывай исходные надписи, не добавляй эффекты, не пересоздавай лицо/товар и не удаляй обязательную маркировку. Юридическую маркировку сохраняй. Иной монтаж/набор только по отдельному прямому заданию Владельца с применимой проверкой типографики Марикой.
5. Проверь подпись, честное указание проверенного автора либо канала/ссылки источника и уместные теги. На российских площадках не вставляй Instagram-ссылки, включая сокращатели и перенаправления; автор обычным текстом, исходное происхождение хранится в частных данных задания. Без приглашения в соавторы. Согласие уже работающих с нами авторов Владелец подтвердил, повторно не спрашивай. Дитер работает самостоятельно, Анжела необязательна. Вьетнамская версия при отдельном задании: HeyGen переводит оригинальную речь с lip sync, автор говорит по-вьетнамски, captions и подпись тоже переводятся; не запускай платный перевод просто по наличию разрешённого метода.
6. Публикуй/отправляй/размещай только недостающие назначения. Только активные назначения из сохранённого scope через подтверждённые официальные API. Facebook: tools/facebook-reels.py, Page1697038263872226, новый журнал на результат; Instagram и YouTube также используют свои устойчивые журналы. YouTube закреплён за UCCL3d3tuxNJSYQgNRGw1uRw (Das Experten Eurasia), другой канал не выбирать автоматически. VK: jobs/diter-vk-upload/runner.py, сообщество229095983, существующий ключ из хранилища; отдельный устойчивый журнал, сначала сверка существующих размещений. Make не запускать. Неподключённые Rutube/TikTok в автоматическом раунде пока не выполнять; не подменять API браузерной публикацией. Все активные назначения публичные: send, draft, private, review или upload accepted не являются доказательством публичной публикации. Проверяй аккаунт в реестре и фактическом UI. Не делай дублей и не меняй чужие публикации.
7. Открой и проверь КАЖДОЕ требуемое назначение: правильный аккаунт, именно этот ролик, автор, подпись, публичность. Уже существующая проверенная публикация подходит. POST ${origin}/internal/ugc/reel-jobs/${id}/complete с X-Emailer-Service-Secret из EMAILER_SERVICE_SECRET (значение не печатай), JSON {claim_id:"${job.claim_id}",publications:[{platform:"${required.join('|')}",url:"прямая ссылка",account:"наш аккаунт",verified:true,verified_at:"ISO время проверки",evidence:"лично проверенные факты"}]}. Зелёный только после всех ${JSON.stringify(required ?? [])} и подтверждённого ERP readback.
Если задача остановлена или реально невыполнима: не делай вид, что выполнено; сохрани уже подтверждённые ссылки в отчёте и POST ${origin}/internal/ugc/reel-jobs/${id}/release с {claim_id:"${job.claim_id}",error:"точная причина и уже проверенные ссылки"}. Никаких автоматических повторных загрузок. Максимум три попытки. Никакие другие FX не запускай.`;
}

// Stable identity makes retries and equivalent YouTube link forms idempotent.
export function publicationKey(item) {
  const url = new URL(item.url);
  const rawHost = url.hostname.toLowerCase().replace(/^www\./, '');
  const host = rawHost === 'vk.ru' ? 'vk.com' : rawHost;
  const path = url.pathname.replace(/\/$/, '');
  if (item.platform === 'youtube') return `youtube:${url.searchParams.get('v') || path.split('/').at(-1)}`;
  if (item.platform === 'instagram') return `instagram:${path.split('/').at(-1)}`;
  if (item.platform === 'threads') return `threads:${path.split('/').at(-1)}`;
  if (item.platform === 'facebook') return `facebook:${url.searchParams.get('v') || path.split('/').at(-1)}`;
  if (item.platform === 'rutube') return `rutube:${path.split('/').at(-1).toLowerCase()}`;
  return `${item.platform}:${host}${path}`;
}
export function appendPublicationProofs(existing, incoming) {
  const merged = [...existing];
  const keys = new Set(existing.map(publicationKey));
  for (const item of incoming) {
    const key = publicationKey(item);
    if (!keys.has(key)) { keys.add(key); merged.push(item); }
  }
  return merged;
}
