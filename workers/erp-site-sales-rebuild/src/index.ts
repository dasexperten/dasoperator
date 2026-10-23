import { erpTriggerWorker, type TriggerEnv } from '../../_shared/trigger-erp';
import { erpWorker } from '../../_shared/run';

const active = erpTriggerWorker('erp-site-sales-rebuild');
const skipped = erpWorker<TriggerEnv>('erp-site-sales-rebuild', async () => ({
  note: 'site_sales_rebuild: not due (SKIPPED — first Wednesday only)',
}));

export default {
  ...active,
  async scheduled(event, env, ctx) {
    // Use the scheduled date even if Cloudflare delivers this tick later. Manual
    // /run remains the explicit active action; other Wednesdays leave a skip log.
    const scheduled = new Date(event.scheduledTime);
    const firstWednesday = scheduled.getUTCDay() === 3 && scheduled.getUTCDate() <= 7;
    await (firstWednesday ? active : skipped).scheduled!(event, env, ctx);
  },
} satisfies ExportedHandler<TriggerEnv>;
