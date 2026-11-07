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
    const checked = Date.parse(String(item.verified_at ?? ''));
    const evidence = String(item.evidence ?? '').trim();
    const account = String(item.account ?? '').trim();
    if (!valid || url.protocol !== 'https:' || url.username || url.password || url.port || !evidence || !account ||
      !Number.isFinite(checked) || checked > Date.now() + 60_000 || item.verified !== true) return null;
    const youtubeId = platform === 'youtube' && path === '/watch' ? url.searchParams.get('v') : null;
    url.search = ''; if (youtubeId) url.searchParams.set('v', youtubeId); url.hash = '';
    let source;
    try { source = new URL(String(sourceUrl)); } catch { source = null; }
    if (source && source.hostname.toLowerCase().replace(/^www\./, '') === host && source.pathname.replace(/\/$/, '') === path.replace(/\/$/, '') && (platform !== 'youtube' || path !== '/watch' || source.searchParams.get('v') === youtubeId)) return null;
    if (source && platform === 'youtube' && ['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(source.hostname.toLowerCase()) && publicationKey({platform,url:source.href}) === publicationKey({platform,url:url.href})) return null;
    if (source && platform === 'vk' && ['vk.com','www.vk.com','vk.ru','www.vk.ru','vkvideo.ru','www.vkvideo.ru'].includes(source.hostname.toLowerCase()) && publicationKey({platform,url:source.href}) === publicationKey({platform,url:url.href})) return null;
    // The same Instagram media shortcode is the original even if /reel becomes /p.
    if (source && platform === 'instagram' && /^(?:www\.)?instagram\.com$/.test(source.hostname) && source.pathname.split('/').filter(Boolean).at(-1) === path.split('/').filter(Boolean).at(-1)) return null;
    result.push({ platform, url: url.href, account: account.slice(0, 160), verified: true,
      verified_at: new Date(checked).toISOString(), evidence: evidence.slice(0, 2000) });
  }
  return result;
}

export function reelTaskText(job, origin) {
  const id = encodeURIComponent(job.content_id);
  const required = typeof job.required_destinations === 'string' ? JSON.parse(job.required_destinations) : job.required_destinations;
  return `Дитер: diter-ugc-round / UGC Selection (UGC-селекция). РОВНО ОДИН уже принятый жёлтый пост: content_id=${job.content_id}; claim_id=${job.claim_id}; источник ${job.content_url}; автор @${job.handle}. Не ищи и не выбирай другой ролик, не трогай зелёные задания. Требуемые публичные площадки: ${JSON.stringify(required ?? ['instagram','threads','vk','youtube','tiktok'])}.
1. Сначала проверь уже существующие публикации именно этого ролика на наших подтверждённых аккаунтах. Сохрани проверенные прямые ссылки и доказательства. Уже опубликованное повторно не загружай. ERP proofs: ${job.publications ?? '[]'}.
2. Скачай оригинал через instagram-downloader, сверь автора, наш товар, длительность, файл и звук. Не выдумывай доступ или результат.
3. Максимально сохрани оригинал; минимальная правка только явно дешёвых фрагментов, упаковки доставки и распаковки. Если Владелец потребовал полный исходник — без вырезаний. Сохрани связную речь и авторскую подачу.
4. Только если в кадре явные рекламные captions: замени уместным кинематографичным текстом, с приёмкой типографического набора Марикой. Юридическую маркировку рекламы автоматически не удаляй и не скрывай. Не добавляй другие эффекты.
5. Проверь подпись, явное указание автора и уместные теги. Без приглашения в соавторы. Согласие уже работающих с нами авторов Владелец подтвердил, повторно не спрашивай. Дитер работает самостоятельно, Анжела необязательна. Вьетнамская версия при отдельном задании: HeyGen переводит оригинальную речь с lip sync, автор говорит по-вьетнамски, captions и подпись тоже переводятся; не запускай платный перевод просто по наличию разрешённого метода.
6. Публикуй/отправляй/размещай только недостающие назначения. Здесь все пять назначений публичные: send, draft, private, review или upload accepted не являются доказательством публичной публикации. Проверяй аккаунт в реестре и фактическом UI. Не делай дублей и не меняй чужие публикации.
7. Открой и проверь КАЖДОЕ требуемое назначение: правильный аккаунт, именно этот ролик, автор, подпись, публичность. Уже существующая проверенная публикация подходит. POST ${origin}/internal/ugc/reel-jobs/${id}/complete с X-Emailer-Service-Secret из EMAILER_SERVICE_SECRET (значение не печатай), JSON {claim_id:"${job.claim_id}",publications:[{platform:"instagram|threads|vk|youtube|tiktok",url:"прямая ссылка",account:"наш аккаунт",verified:true,verified_at:"ISO время проверки",evidence:"лично проверенные факты"}]}. Зелёный только после всех ${JSON.stringify(required ?? [])} и подтверждённого ERP readback.
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
