import assert from 'node:assert/strict';
import {dropName} from './diana-no-name.mjs';
const now=Date.parse('2026-11-15T10:00:00Z');
const today=[{direction:'out',text:'Елена, понравилось, что для вас важен комфорт.',at:Date.parse('2026-11-15T09:00:00Z')},{direction:'in',text:'расскажите'}];
const yesterday=[{direction:'out',text:'Елена, понравилось, что для вас важен комфорт.',at:Date.parse('2026-11-14T09:00:00Z')},{direction:'in',text:'расскажите'}];
// once a day: already used today → stripped
assert.equal(dropName('Елена, у TERMO необычный формат. Попробуем?',today,{now}),'У TERMO необычный формат. Попробуем?');
assert.equal(dropName('Отлично! Елена, когда ждать ролик?',today,{now}),'Отлично! Когда ждать ролик?');
assert.equal(dropName('Отлично, Елена, ждём ролик!',today,{now}),'Отлично, ждём ролик!');
// new day → allowed once
assert.equal(dropName('Елена, когда ждать ролик?',yesterday,{now}),'Елена, когда ждать ролик?');
// second time today allowed only for payment
assert.equal(dropName('Елена, перевели вам 434 ₽ по СБП.',today,{now}),'Елена, перевели вам 434 ₽ по СБП.');
const twice=[...today,{direction:'out',text:'Елена, подскажите банк для перевода?',at:Date.parse('2026-11-15T09:30:00Z')}];
assert.equal(dropName('Елена, перевели вам 434 ₽.',twice,{now}),'Перевели вам 434 ₽.');
// first message of a chat keeps it
assert.equal(dropName('Елена, привет! Мы Das Experten.',[],{now}),'Елена, привет! Мы Das Experten.');
assert.equal(dropName('Отлично, ждём ролик!',today,{now}),'Отлично, ждём ролик!');
console.log('ok');
