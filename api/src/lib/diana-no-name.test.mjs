import assert from 'node:assert/strict';
import {dropName} from './diana-no-name.mjs';
const h=[{direction:'out',text:'Елена, понравилось, что при выборе одежды для вас важны комфорт и настроение.'},{direction:'in',text:'расскажите подробнее'}];
assert.equal(dropName('Елена, у TERMO необычный формат: паста с ферментами. Попробуем?',h),'У TERMO необычный формат: паста с ферментами. Попробуем?');
assert.equal(dropName('Отлично, Елена, ждём ролик!',h),'Отлично, ждём ролик!');
assert.equal(dropName('Отлично! Елена, когда ждать ролик?',h),'Отлично! Когда ждать ролик?');
assert.equal(dropName('Отлично, ждём ролик!',h),'Отлично, ждём ролик!');
assert.equal(dropName('Елена, привет! Мы Das Experten.',[]),'Елена, привет! Мы Das Experten.'); // first message keeps the name
assert.equal(dropName('Мария, подскажите банк?',h),'Подскажите банк?');
console.log('ok');
