import test from 'node:test';
import assert from 'node:assert/strict';
import { bloggerName, cityOf, handleName, personName, withSurname } from './ugc-person-name.mjs';

test('only the person stays: topics, emoji and places go (Owner 2026-10-16)', () => {
  assert.equal(personName('Life blog| рецепты| распаковки'), '');
  assert.equal(personName('Рукият| Life blog| Находки| ВБ| Ozon'), 'Рукият');
  assert.equal(personName('ЮЛИЯ'), 'Юлия');
  assert.equal(personName('БЛОГЕР Анастасия САМАРА'), 'Анастасия');
  assert.equal(personName('Марина Духненко ресницы/бомбочки/обучение/Москва'), 'Марина Духненко');
  assert.equal(personName('🌿.« Жизнь продолжается.»🌿'), '');
  assert.equal(personName('https://www.youtube.com/shorts/x'), '');
});

test('the handle completes the name («amina_axmedova19» → Амина)', () => {
  assert.equal(handleName('amina_axmedova19'), 'Амина');
  assert.equal(bloggerName('А. Ахмедова', 'amina_axmedova19'), 'Амина Ахмедова');
  assert.equal(bloggerName('Life blog| рецепты| распаковки', 'madifood_'), '');
  assert.equal(bloggerName('ВАЛБЕРИС 💎OZON💎НАХОДКИ💎', 'regina_blog2025'), 'Регина');
  assert.equal(bloggerName('LARISA|LIFE BLOG', 'larrrsi'), 'Лариса');
});

test('city from the profile name or the handle', () => {
  assert.equal(cityOf('Яна Волгоград'), 'Волгоград');
  assert.equal(cityOf('Инна| Syktyvkar'), 'Сыктывкар');
  assert.equal(cityOf('irinkaanik_stavropol31'), 'Ставрополь');
  assert.equal(cityOf('Екатерина /Москва'), 'Москва');
  assert.equal(cityOf('Анна Филиппова'), '');
});

test('a surname from the card only when the card is hers', () => {
  assert.equal(withSurname('Саида', { first_name: 'Саида', last_name: 'Гичиева' }), 'Саида Гичиева');
  assert.equal(withSurname('Любовь', { first_name: 'Дмитрий', last_name: 'Загурский' }), 'Любовь');
});
