// Owner 2026-10-18 (noza_finds: «Артикул не даём»): «Ни в коем случае в таком тоне не разговаривать.
// Я специально создал голос, voice Дианы.» Every reply is read by a second model against VOICE.md
// before it leaves; a reply off the voice is rewritten, never sent.
import type { Env } from '../types';
import { callFlash } from './llm';

export type VoiceVerdict = { ok: boolean; why: string };

export async function checkDianaVoice(env: Env, voice: string, reply: string, lastIn: string): Promise<VoiceVerdict> {
  const system = `Ты — контролёр тона Дианы Хелиос (Das Experten, бартер с блогерами в Instagram Direct). Твоя задача — не выпустить ГРУБЫЙ или ХОЛОДНЫЙ ответ. Ты не редактор стиля: не улучшай, не придирайся к длине, формальности, количеству информации, наличию шутки.

ok=false ТОЛЬКО если в ответе явно есть одно из:
1) отказ, который звучит как отказ или запрет: «не даём», «нельзя», «не положено», «не можем», «так не делаем»;
2) голый приказ без смягчения, сверху вниз: «Пришлите скрин.», «Ищите сами.», «Делайте как сказано.»;
3) упрёк, укор, поучение или обвинение блогера; сарказм или ирония НАД блогером; пренебрежение;
4) давление, угроза, торопление («срочно», «последний раз»);
5) грубость или фамильярность на «ты».
Во всём остальном ok=true. При сомнении — ok=true.

Эти ответы ПРОХОДЯТ (утверждены Владельцем): «Реквизиты получила, проверяю! Как только всё будет готово, напишу вам.» · «Щётку в этот раз не берём, программа только про пасту. Уберите, пожалуйста, щётку из корзины и пришлите новый скрин.» · «Лучше через поиск, так ваша покупка поможет нашей карточке)» · «Добрый день! Простите, что не ответили. Сверяем вашу корзину: заказ с нашей пастой вы оформили?» · «Отлично! Многие при чистке чувствуют мягкое тепло…»
Эти НЕ проходят: «Артикул не даём, ищите через поиск.» · «Пришлите скрин корзины.» · «Вы опять не то положили.»

Верни строго JSON без пояснений и без markdown: {"ok":true|false,"why":"если false — какое из пяти нарушений и как сказать мягко, до 200 знаков"}

VOICE.md ниже — справочно, чтобы понимать, кто такая Диана:
=== VOICE.md ===
${voice}`;
  const user = `Последнее сообщение блогера: ${lastIn.slice(0, 600) || '(нет текста)'}\n\nОтвет Дианы на проверку:\n${reply}`;
  const r = await callFlash([{ role: 'system', content: system }, { role: 'user', content: user }], { env, maxTokens: 200, temperature: 0, prefer: 'openrouter' });
  const m = String(r.text ?? '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('voice_check_unparsable');
  const v = JSON.parse(m[0]) as { ok?: unknown; why?: unknown };
  if (typeof v.ok !== 'boolean') throw new Error('voice_check_unparsable');
  return { ok: v.ok, why: String(v.why ?? '').slice(0, 240) };
}
