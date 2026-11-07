// Owner 2026-11-07: three active destinations; VK/TikTok deferred, history retained.
export const REEL_SCOPE_VERSION = 'ugc-select-three-2026-11-07';
export const ACTIVE_REEL_DESTINATIONS = Object.freeze(['instagram','threads','youtube']);
export const DEFERRED_REEL_DESTINATIONS = Object.freeze(['vk','tiktok']);
export function reelScope(job = {}) {
  const saved = typeof job.required_destinations === 'string' ? JSON.parse(job.required_destinations) : job.required_destinations;
  if (saved != null && !Array.isArray(saved)) throw new Error('invalid_saved_destinations');
  const original = saved ?? [];
  if (original.some(x=>![...ACTIVE_REEL_DESTINATIONS,...DEFERRED_REEL_DESTINATIONS].includes(x))) throw new Error('unknown_saved_destination');
  const baseline = original.length ? original : ACTIVE_REEL_DESTINATIONS;
  return { version: REEL_SCOPE_VERSION, active: baseline.filter(x=>ACTIVE_REEL_DESTINATIONS.includes(x)),
    deferred: baseline.filter(x=>DEFERRED_REEL_DESTINATIONS.includes(x)), original_required_destinations: [...original],
    model_policy: { codex: 'gpt-6.1-terra', higher_model_fallback: false },
    accounts: { instagram:'dasexperten',threads:'dasexperten',youtube_channel_id:'UCCL3d3tuxNJSYQgNRGw1uRw' } };
}
export function reelJobScopeView(job) { return {...job, destination_scope:reelScope(job), active_destinations:reelScope(job).active, deferred_destinations:reelScope(job).deferred}; }
// Owner 2026-11-07: minimal re-edit of an explicitly selected creator reel.
export const REEL_STATUSES = new Set(['queued', 'working', 'published']);
export function reelPublicationProof(value, sourceUrl) {
  if (!Array.isArray(value) || !value.length || value.length > 12) return null;
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
  return `Дитер: diter-ugc-round / UGC Selection (UGC-селекция). РОВНО ОДИН уже принятый жёлтый пост: content_id=${job.content_id}; claim_id=${job.claim_id}; источник ${job.content_url}; автор @${job.handle}. Не ищи и не выбирай другой ролик, не трогай зелёные задания. Требуемые публичные площадки: ${JSON.stringify(required)}; версия ${scope.version}. VK/TikTok отложены Владельцем: НЕ выполнять. Исторический scope ${JSON.stringify(scope.original_required_destinations)} не стирать. Модель операции: Codex gpt-6.1-terra, без более высокой модели/fallback; чистые API-вызовы без модели.
1. Instagram проверяй первым отдельно: полный официальный collaborative_media (принятые соавторства) и collaboration_invites (ожидающие), затем собственный /media. Точное совпадение источника и принятое соавторство ИЛИ уже существующий собственный пост => сохранить доказательство, НЕ публиковать дубль. Pending, ошибка API, неизвестный mediaID или неполная пагинация не являются отсутствием: остановить только Instagram, остальные активные назначения можно выполнить. Используй docs/INSTAGRAM_COLLAB_CHECK.md и jobs/diter-ugc-round/instagram_api.py. Сначала проверь уже существующие публикации именно этого ролика на наших подтверждённых аккаунтах. Сохрани проверенные прямые ссылки и доказательства. Уже опубликованное повторно не загружай. ERP proofs: ${job.publications ?? '[]'}.
2. Скачай оригинал ОДИН раз через официальный Apify по instagram-downloader (не удалённый apifier-bridge), затем переиспользуй файл во всех трёх API, сверь автора, наш товар, длительность, файл и звук. Не выдумывай доступ или результат.
3. Сохрани всё использование товара, смысл, автора и связную речь. В обычном раунде можно убрать ТОЛЬКО распаковку; не режь «дешёвые», слабые или иные продуктовые фрагменты по своему вкусу. Прямое указание Владельца сохранить весь оригинал означает никаких вырезаний, включая распаковку.
4. Не переписывай исходные надписи, не добавляй эффекты, не пересоздавай лицо/товар и не удаляй обязательную маркировку. Юридическую маркировку сохраняй. Иной монтаж/набор только по отдельному прямому заданию Владельца с применимой проверкой типографики Марикой.
5. Проверь подпись, явное указание автора и уместные теги. Без приглашения в соавторы. Согласие уже работающих с нами авторов Владелец подтвердил, повторно не спрашивай. Дитер работает самостоятельно, Анжела необязательна. Вьетнамская версия при отдельном задании: HeyGen переводит оригинальную речь с lip sync, автор говорит по-вьетнамски, captions и подпись тоже переводятся; не запускай платный перевод просто по наличию разрешённого метода.
6. Публикуй/отправляй/размещай только недостающие назначения. Только активные Instagram/Threads/YouTube через подтверждённые официальные API. YouTube закреплён за UCCL3d3tuxNJSYQgNRGw1uRw (Das Experten Eurasia), другой канал не выбирать автоматически. VK/TikTok сейчас НЕ выполнять. Все активные назначения публичные: send, draft, private, review или upload accepted не являются доказательством публичной публикации. Проверяй аккаунт в реестре и фактическом UI. Не делай дублей и не меняй чужие публикации.
7. Открой и проверь КАЖДОЕ требуемое назначение: правильный аккаунт, именно этот ролик, автор, подпись, публичность. Уже существующая проверенная публикация подходит. POST ${origin}/internal/ugc/reel-jobs/${id}/complete с X-Emailer-Service-Secret из EMAILER_SERVICE_SECRET (значение не печатай), JSON {claim_id:"${job.claim_id}",publications:[{platform:"instagram|threads|youtube",url:"прямая ссылка",account:"наш аккаунт",verified:true,verified_at:"ISO время проверки",evidence:"лично проверенные факты"}]}. Зелёный только после всех ${JSON.stringify(required ?? [])} и подтверждённого ERP readback.
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
