import { erpWorker, type BaseEnv } from '../../_shared/run';
import { todayUtcDate, refreshFxFromCbr } from '../../../api/src/lib/fx-cbr';
import { storeSnapshot } from '../../../api/src/lib/fx-store';
import { refreshPricingRates } from '../../../api/src/lib/fx-pricing';
import type { Env as ErpEnv } from '../../../api/src/types';

interface Env extends BaseEnv {
  FX: KVNamespace;
}

export default erpWorker<Env>('erp-fx-rates', async (env, dry) => {
  const date = todayUtcDate();
  const snapshot = await refreshFxFromCbr(date);
  const cbrRates = snapshot ? Object.keys(snapshot.rates).length : 0;

  if (dry) {
    return { rows: cbrRates, note: `dry · CBR ${date}: ${snapshot ? cbrRates + ' rates' : 'unreachable'}` };
  }

  if (snapshot) await storeSnapshot(env.FX, snapshot);
  // Pricing rates run even when CBR is down — same as the ERP branch this replaces.
  const pricing = await refreshPricingRates(env as unknown as ErpEnv);

  if (!snapshot) throw new Error(`CBR unreachable for ${date}; last snapshot kept · pricing ${JSON.stringify(pricing)}`);
  return { rows: cbrRates, note: `CBR ${date} · pricing ${JSON.stringify(pricing).slice(0, 300)}` };
});
