// Retired after rename; no cron and no work. Historical journal records remain unchanged.
import { erpWorker, type BaseEnv } from '../../_shared/run';
export default erpWorker<BaseEnv>('erp-ugc-link-health', async () => ({ note: 'retired: use erp-ugc-postlink' }));
