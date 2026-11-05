// Read-only: Cloudflare analytics for given workers between two times (Owner 2026-11-06 outage study).
const [from, to, ...scripts] = process.argv.slice(2);
const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
async function q(token, query) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  return r.json();
}
for (const s of scripts) {
  for (const token of [process.env.T1, process.env.T2].filter(Boolean)) {
    const d = await q(token, `{viewer{accounts(filter:{accountTag:"${acct}"}){workersInvocationsAdaptive(limit:500,filter:{scriptName:"${s}",datetime_geq:"${from}",datetime_leq:"${to}"},orderBy:[datetimeFifteenMinutes_ASC]){sum{requests errors subrequests} quantiles{wallTimeP50 wallTimeP99 cpuTimeP50} dimensions{datetimeFifteenMinutes status}}}}}`);
    if (d.errors) { console.log(s, 'ERR', JSON.stringify(d.errors).slice(0, 300)); continue; }
    console.log('=====', s);
    for (const r of d.data.viewer.accounts[0].workersInvocationsAdaptive) console.log(r.dimensions.datetimeFifteenMinutes.slice(11, 16), r.dimensions.status.padEnd(16), 'req', r.sum.requests, 'err', r.sum.errors, 'sub', r.sum.subrequests, 'wallP50', Math.round(r.quantiles.wallTimeP50 / 1000), 'ms wallP99', Math.round(r.quantiles.wallTimeP99 / 1000), 'ms');
    break;
  }
}
for (const token of [process.env.T2, process.env.T1].filter(Boolean)) {
  const d = await q(token, `{viewer{accounts(filter:{accountTag:"${acct}"}){durableObjectsInvocationsAdaptiveGroups(limit:500,filter:{datetime_geq:"${from}",datetime_leq:"${to}"},orderBy:[datetimeFifteenMinutes_ASC]){sum{requests errors} quantiles{wallTimeP50 wallTimeP99} dimensions{datetimeFifteenMinutes scriptName status}}}}}`);
  if (d.errors) { console.log('DO ERR', JSON.stringify(d.errors).slice(0, 300)); continue; }
  console.log('===== durable objects');
  for (const r of d.data.viewer.accounts[0].durableObjectsInvocationsAdaptiveGroups) console.log(r.dimensions.datetimeFifteenMinutes.slice(11, 16), r.dimensions.scriptName, r.dimensions.status, 'req', r.sum.requests, 'err', r.sum.errors, 'wallP50', Math.round((r.quantiles.wallTimeP50||0) / 1000), 'ms wallP99', Math.round((r.quantiles.wallTimeP99||0) / 1000), 'ms');
  break;
}
