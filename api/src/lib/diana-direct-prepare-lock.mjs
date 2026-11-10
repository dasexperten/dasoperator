// Internal prepare-only restart gate. Never removes or replaces another owner.
export async function reservePrepareExecution(env,owner,{reserve,read}){
 if(owner?.kind!=='direct'||typeof owner.id!=='string'||!owner.id)throw Error('prepare_owner_invalid');
 if(await reserve(env,owner))return true;
 const current=await read(env);
 return current?.kind===owner.kind&&current.id===owner.id;
}
