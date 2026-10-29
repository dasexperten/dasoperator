// Deployment is finished only after the image rollout, not just Worker upload.
const account='081ddb85cb399ad62a70210328d744fc';
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)throw Error('deployment_token_required');
const base=`https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications`;
async function get(url){const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});const j=await r.json();if(!r.ok||!j.success)throw Error(`container_status_http_${r.status}`);return j.result;}
const app=(await get(base)).find(a=>a.name==='diana-subscription-runner-codexrunner');
if(!app)throw Error('container_application_missing');
const deadline=Date.now()+12*60_000;
while(Date.now()<deadline){
 const rollouts=await get(`${base}/${app.id}/rollouts`);const latest=rollouts[0];
 if(!latest){console.log('Initial application created; first runtime smoke is required before activation.');process.exit(0);}
 console.log(`Container rollout: ${latest.status}; healthy=${latest.health?.instances?.healthy??0}`);
 if(latest.status==='completed'){console.log('Container image rollout completed.');process.exit(0);}
 if(['failed','paused','stalled'].includes(latest.status))throw Error(`container_rollout_${latest.status}`);
 await new Promise(r=>setTimeout(r,15000));
}
throw Error('container_image_rollout_not_ready');
