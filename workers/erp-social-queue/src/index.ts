import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { articleTick } from '../../_social/article-service.mjs';
// @ts-expect-error plain JS module
import { offerTick } from '../../_social/offer-post.mjs';

interface Env extends BaseEnv {
  ORG_DB: D1Database;
  ARCHIVE: R2Bucket;
  META_SYSTEM_USER_TOKEN?: string;
  GITHUB_TOKEN?: string;
}

// Same as the angela-social tick: articles, then offers, each result kept in R2 where
// Angela's seat reads it. The queue lives in the board database (env.DB for the seat code).
export default erpWorker<Env>('erp-social-queue', async (env, dry) => {
  if (dry) return { note: 'dry · nothing posted to Meta' };
  const seat = { ...env, DB: env.ORG_DB };
  const at = () => new Date().toISOString();
  const errors: string[] = [];
  let article: unknown = null;
  let offers: unknown = null;
  try {
    article = await articleTick(seat);
    await env.ARCHIVE.put('Social/angela/latest-run.json', JSON.stringify({ at: at(), ...(article as object) }));
  } catch (e) {
    errors.push(`articles: ${String(e).slice(0, 200)}`);
    await env.ARCHIVE.put('Social/angela/latest-run.json', JSON.stringify({ at: at(), error: 'Article distribution failed; inspect queue and credentials' }));
  }
  try {
    offers = await offerTick(seat);
    await env.ARCHIVE.put('Social/angela/latest-offer-run.json', JSON.stringify({ at: at(), results: offers }));
  } catch (e) {
    errors.push(`offers: ${String(e).slice(0, 200)}`);
    await env.ARCHIVE.put('Social/angela/latest-offer-run.json', JSON.stringify({ at: at(), error: String(e).slice(0, 200) }));
  }
  if (errors.length) throw new Error(errors.join(' · '));
  return { note: JSON.stringify({ article, offers }).slice(0, 600) };
});
