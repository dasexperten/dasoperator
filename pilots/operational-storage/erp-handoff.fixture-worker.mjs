import {createAtomicHandoffEndpoint} from './atomic-handoff.mjs';
import {createErpHandoffPersistence} from './erp-handoff-persistence.mjs';
// Intentionally NON-AUTHENTIC synthetic test double, never mount/deploy this worker.
export default {fetch(request,env){return createAtomicHandoffEndpoint({agent:'angela',config:{namespace:'pilot-erp',agents:{angela:'shadow','diana-helios':'off'}},db:createErpHandoffPersistence(env.DB),verifyTrustedSource:async input=>input.sourceKey})(request,{synthetic:true});}};
