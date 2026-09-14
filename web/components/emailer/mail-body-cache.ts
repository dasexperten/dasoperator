import type { GmailMessage } from '@/lib/gmail-api';

/** Per-component memory only: no storage, no read-state changes, no attachment downloads. */
export class MailBodyCache {
  private values=new Map<string,{message:GmailMessage;until:number}>();
  private requests=new Map<string,Promise<GmailMessage>>();
  private generation=0;
  constructor(private load:(account:string,id:string)=>Promise<GmailMessage>) {}
  get pendingCount() { return this.requests.size; }
  clear() {this.generation++;this.values.clear();this.requests.clear();}
  read(account:string,id:string):Promise<GmailMessage> {
    const key=`${account}:${id}`;
    const value=this.values.get(key);
    if(value && value.until>Date.now()) {
      this.values.delete(key);this.values.set(key,value);
      return Promise.resolve(value.message);
    }
    this.values.delete(key);
    const existing=this.requests.get(key);
    if(existing)return existing;
    const generation=this.generation;
    const pending=this.load(account,id).then(message=>{
      if(generation===this.generation && (message.html?.length || 0)+(message.text?.length || 0)<500000) {
        while(this.values.size>=16)this.values.delete(this.values.keys().next().value!);
        this.values.set(key,{message,until:Date.now()+60000});
      }
      return message;
    }).finally(()=>{if(this.requests.get(key)===pending)this.requests.delete(key);});
    this.requests.set(key,pending);
    return pending;
  }
}
