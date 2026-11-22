import {createAtomicHandoffEndpoint} from './atomic-handoff.mjs';
// ONLY a synthetic test double. No account authentication or real evidence exists.
export default {fetch(request,env) {
 return createAtomicHandoffEndpoint({agent:'angela',config:{namespace:'pilot-atomic',agents:{angela:'shadow','diana-helios':'off'}},db:env.DB,
 verifyTrustedSource:async input=>input.sourceKey})(request,Object.freeze({synthetic:true}));
}};
