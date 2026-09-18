import { erpWorker, type BaseEnv } from '../../_shared/run';
import { relinkUnlinked } from '../../../api/src/lib/email-relink';
import type { Env as ErpEnv } from '../../../api/src/types';

interface Env extends BaseEnv {
  ARCHIVE: R2Bucket;
}

export default erpWorker<Env>('erp-mail-relink', async (env, dry) => {
  if (dry) return { note: 'dry · relink skipped' };
  const r = await relinkUnlinked(env as unknown as ErpEnv);
  return { rows: r.linked, note: JSON.stringify(r) };
});
