import test from 'node:test';import assert from 'node:assert/strict';
import {leadStage} from './ugc-lead-stage.mjs';
test('Owner 2026-11-13: real replies of 13.11 get the right stage',()=>{
 assert.equal(leadStage(['Да','Какой ключ поиска?','Или по артикулу']),'agreed');
 assert.equal(leadStage(['Здравствуйте 🌺 Интересное предложение, я бы хотела с вами посотрудничать, но и уточнить некоторые детали🌺']),'agreed');
 assert.equal(leadStage(['хотела несколько вопросов уточнить ещё: 1. Какой дедлайн после получения заказа?']),'replied');
 assert.equal(leadStage(['Благодарю, но не актуально']),null);
 assert.equal(leadStage(['Нет , отказано )']),null);
 assert.equal(leadStage([]),null);
});
