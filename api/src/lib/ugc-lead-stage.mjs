// Owner 2026-11-13: «where are the new leads on my UGC page». A blogger who answered our
// invitation gets her stage at once: agreed when she says yes, replied otherwise.
// Owner 2026-11-20 (48-hour check): a clear «no» is a stage too — six refusals stayed
// «replied»/«agreed» on the page, and «неактуально» was read as «актуально» = agreed.
const REFUSAL=/не\s*актуальн|не\s*интерес|откаж|отказ|не\s+смогу|не\s+получится|не\s+сотруднича|не\s+готова|не\s+беру|не\s+работаю|нет,?\s+спасибо|^\s*(?:нет|неа|не)\s*[.!)]*\s*$|не\s+занимаюсь|только\s+(?:за\s+)?(?:оплат|деньг)|прайс/i;
const YES=/^\s*(?:да|ага|конечно|давайте|можно|ок|окей|хорошо)(?![а-яё])|соглас|интересн|с\s+удовольствием|готова|хочу|посотруднича|подходит|актуальн/i;
/** The stage her newest messages show: refused, agreed or replied; null when she wrote nothing. */
export function leadStage(texts){
 const t=(texts??[]).map(x=>String(x??'').trim()).filter(Boolean);
 if(!t.length)return null;
 if(t.some(x=>REFUSAL.test(x)))return 'refused';
 return t.some(x=>YES.test(x))?'agreed':'replied';
}
