// Acceptance scoring for the screenshot reader. Cases are REAL creator
// screenshots labelled by a person; images live outside git (they hold private
// data). A case: {file, kind, product, seller, price_minor, currency}. Fabricated
// or synthetic images never count as acceptance.
import {readFileSync} from 'node:fs';
import {checkSubscriptionImages} from './diana-subscription-vision.mjs';

const minor=(v)=>{const m=String(v??'').replace(/\s/g,'').replace(',','.').match(/\d+(?:\.\d+)?/);return m?Math.round(parseFloat(m[0])*100):null;};

export function scoreCase(expected,check){
  const o=check?.observed??{};
  const got={kind:check?.kind??null,product:check?.product??null,seller:check?.seller??null,price_minor:minor(o.price),currency:o.currency??null};
  const fails=[];
  for(const k of ['kind','product','seller'])if(expected[k]!=null&&got[k]!==expected[k])fails.push(k);
  if(expected.price_minor!=null&&got.price_minor!==expected.price_minor)fails.push('price');
  if(expected.currency!=null&&String(got.currency??'').toUpperCase()!==String(expected.currency).toUpperCase())fails.push('currency');
  // A wrong confident amount is worse than an honest unknown.
  const wrongConfident=fails.includes('price')&&got.price_minor!=null&&check?.amount==='yes';
  return {file:expected.file,pass:fails.length===0,fails,wrongConfident,got};
}

export async function runAcceptance({dir,cases,infer,policy={},readFile=(p)=>readFileSync(p)}){
  const results=[];
  for(const c of cases){
    const bytes=readFile(`${dir}/${c.file}`);
    const mediaType=/\.jpe?g$/i.test(c.file)?'image/jpeg':'image/png';
    const out=await checkSubscriptionImages({images:[{label:c.file,data:Buffer.from(bytes).toString('base64'),mediaType}],task:'acceptance',policy,infer});
    results.push(scoreCase(c,out.checks?.[0]));
  }
  const pass=results.filter(r=>r.pass).length;
  return {total:results.length,pass,wrongConfident:results.filter(r=>r.wrongConfident).length,results};
}
