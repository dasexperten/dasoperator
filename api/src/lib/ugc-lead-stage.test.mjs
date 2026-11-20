import test from 'node:test';import assert from 'node:assert/strict';
import {leadStage} from './ugc-lead-stage.mjs';
test('Owner 2026-11-13: real replies of 13.11 get the right stage',()=>{
 assert.equal(leadStage(['Да','Какой ключ поиска?','Или по артикулу']),'agreed');
 assert.equal(leadStage(['Здравствуйте 🌺 Интересное предложение, я бы хотела с вами посотрудничать, но и уточнить некоторые детали🌺']),'agreed');
 assert.equal(leadStage(['хотела несколько вопросов уточнить ещё: 1. Какой дедлайн после получения заказа?']),'replied');
 assert.equal(leadStage(['Благодарю, но не актуально']),'refused');
 assert.equal(leadStage(['Нет , отказано )']),'refused');
 assert.equal(leadStage([]),null);
});
test('Owner 2026-11-20: the refusals of 18–19.11 are refusals, never agreed',()=>{
 for(const x of ['Неа','Здравствуйте! Спасибо за предложение, но я по бартеру не работаю.','Спасибо,не актуально','Добрый день 🙌  Я не готова сотрудничать 🙌 Спасибо за предложение))','Здравствуйте✨ Благодарю вас за интерес к моей странице. На данном этапе неактуально предложение🙌🏼','Добрый вечер  Благодарю за предложение, но бартер на зубную пасту мне не интересен','Здравствуйте! Спасибо за предложение, но откажусь'])
  assert.equal(leadStage([x]),'refused',x);
 assert.equal(leadStage(['Здравствуйте, попробую']),'replied');
 assert.equal(leadStage(['Здравствуйте , да конечно .']),'replied');
});
