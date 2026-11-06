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
      : platform === 'vk' ? ['vk.com', 'vkvideo.ru'].includes(host) && /^\/(?:wall|video|clip)-?\d+_\d+\/?$/.test(path)
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
    // The same Instagram media shortcode is the original even if /reel becomes /p.
    if (source && platform === 'instagram' && /^(?:www\.)?instagram\.com$/.test(source.hostname) && source.pathname.split('/').filter(Boolean).at(-1) === path.split('/').filter(Boolean).at(-1)) return null;
    result.push({ platform, url: url.href, account: account.slice(0, 160), verified: true,
      verified_at: new Date(checked).toISOString(), evidence: evidence.slice(0, 2000) });
  }
  return result;
}

export function reelTaskText(job, origin) {
  const id = encodeURIComponent(job.content_id);
  return `Дитер: UGC Selection (UGC-селекция). Владелец двойным кликом по иконке UGC ERP выбрал ролик ${job.content_url}. Автор: @${job.handle}. Задание очереди: ${job.content_id}.
Сначала реально начни работу: POST ${origin}/internal/ugc/reel-jobs/${id}/claim с X-Emailer-Service-Secret из штатного EMAILER_SERVICE_SECRET (не печатай значение). Сохрани возвращённый claim_id. HTTP-доставка этого задания не означает начало работы.
Скачай оригинал через instagram-downloader; сверь автора и наш товар. Если Владелец потребовал полный исходник, публикуй без вырезаний. Иначе минимальное вмешательство: вырежи распаковку, упаковку доставки и явно дешёвые фрагменты. Сохрани авторскую подачу и связную речь, не добавляй эффекты/надписи и не переделывай ролик. Если полезной части нет, не публикуй пустой монтаж. Согласие уже работающих с нами UGC-авторов Владелец подтвердил; повторно не спрашивать. Укажи автора в подписи, без приглашения в соавторы.
Разрешена публикация в наших Instagram, Threads, VK, YouTube и TikTok самостоятельно, участие Анжелы не обязательно. Аккаунты бери из реестра, чужой/неподтверждённый аккаунт не выбирай. Вьетнамская версия при необходимости: HeyGen переводит оригинальную речь с lip sync, автор говорит по-вьетнамски; подпись, субтитры и текст в кадре переводятся тоже. Это разрешение метода, не требование тратить кредиты без доступа.
После реальной публикации открой её и проверь автора/аккаунт, видео и подпись. POST ${origin}/internal/ugc/reel-jobs/${id}/complete с тем же служебным заголовком и JSON {claim_id, publications:[{platform:"instagram|threads|vk|youtube|tiktok",url:"прямая ссылка новой публикации",account:"наш аккаунт",verified:true,verified_at:"ISO время проверки",evidence:"что лично проверено"}]}. Зелёный только после сохранения этих доказательств. Если Владелец задал конкретный набор площадок, исполни весь набор. Поздние проверенные ссылки добавь POST ${origin}/internal/ugc/reel-jobs/${id}/publications с {publications:[...]} без замены старых ссылок. Этот вызов не меняет первоначальную дату публикации.
Если реально выполнить нельзя: POST ${origin}/internal/ugc/reel-jobs/${id}/release с {claim_id,error:"точная причина"}; ролик остаётся в красной очереди с причиной. Не имитируй монтаж, публикацию или callback; максимум 3 попытки. Задача до проверенного результата, без исходящих сообщений людям кроме разрешённого отчёта Владельцу.`;
}

// Stable identity makes retries and equivalent YouTube link forms idempotent.
export function publicationKey(item) {
  const url = new URL(item.url);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
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
