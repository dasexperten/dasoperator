// Owner 2026-11-13: «where are the new leads on my UGC page». A blogger who answered our
// invitation without refusing gets a card at once: agreed when she says yes, replied otherwise.
const REFUSAL=/не\s+актуальн|не\s+интересн|откаж|отказ|не\s+смогу|не\s+получится|не\s+сотруднича|не\s+беру|нет,?\s+спасибо|^\s*нет\s*[.!)]*\s*$|не\s+занимаюсь|только\s+(?:за\s+)?(?:оплат|деньг)|прайс/i;
const YES=/^\s*(?:да|ага|конечно|давайте|можно|ок|окей|хорошо)(?![а-яё])|соглас|интересн|с\s+удовольствием|готова|хочу|посотруднича|подходит|актуальн/i;
/** The stage her newest messages show, or null when she refused or wrote nothing. */
export function leadStage(texts){
 const t=(texts??[]).map(x=>String(x??'').trim()).filter(Boolean);
 if(!t.length||t.some(x=>REFUSAL.test(x)))return null;
 return t.some(x=>YES.test(x))?'agreed':'replied';
}
