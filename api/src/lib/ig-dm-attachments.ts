import type { Env } from '../types';
import type { LlmImage } from './llm';
import { refreshIgAttachments } from './ig-dm-watch';
import { imageUrls, loadInstagramImage } from './ig-dm-image-cache';
export { imageUrls } from './ig-dm-image-cache';
const MAX_TOTAL_BYTES = 16_000_000;
const MAX_IMAGES = 6;
type Message = { id?: string; direction: string; created_at: string; attachments_json: string | null };

export async function incomingScreenshots(env: Env, history: Message[], at: string): Promise<{images: LlmImage[]; unreadable: number}> {
  const recent = history.filter(m => m.direction==='in' && m.attachments_json && m.attachments_json!=='[]' && Date.parse(m.created_at)>=Date.parse(at)-7*86_400_000);
  const selected: {message: Message; index: number; url: string}[] = []; let unreadable=0;
  for (const message of recent) {
    let urls: string[];
    try { urls=imageUrls(message.attachments_json); }
    catch { const fresh=message.id ? await refreshIgAttachments(env,message.id) : null; if(!fresh){unreadable++;continue;} try{urls=imageUrls(fresh);}catch{unreadable++;continue;} }
    urls.forEach((url,index)=>selected.push({message,index,url}));
  }
  const images: LlmImage[]=[];let total=0;
  // New screenshots get priority; an expired old one cannot hide a new one.
  for(const item of selected.slice(-MAX_IMAGES).reverse()){
    try {
      let image;
      try { image=await loadInstagramImage(env,item.message.id,item.index,item.url); }
      catch {
        const fresh=item.message.id ? await refreshIgAttachments(env,item.message.id) : null;
        const url=fresh ? imageUrls(fresh)[item.index] : null;
        if(!url)throw new Error('Image refresh failed');
        image=await loadInstagramImage(env,item.message.id,item.index,url);
      }
      if(total+image.size>MAX_TOTAL_BYTES){unreadable++;continue;}
      total+=image.size;
      images.unshift({mediaType:image.mediaType,data:image.data,label:`Скриншот из входящего сообщения ${item.message.created_at}, вложение ${item.index+1}.`});
    }catch{unreadable++;}
  }
  return {images,unreadable};
}
