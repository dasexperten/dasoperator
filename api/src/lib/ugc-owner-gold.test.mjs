import test from 'node:test';import assert from 'node:assert/strict';
import {ownerSaidGold,markOwnerGold} from './ugc-owner-gold.mjs';
test('Owner 2026-11-20: his own words about the Gold list are a Gold mark',()=>{
 for(const x of ['Мы вас будем ставить в наш золотой список блоггеров','Вы в нашем золотом списке!!!','Ставим вас в gold список','you are on our golden list','Вы в голд листе','Gold list!'])assert.equal(ownerSaidGold(['Спасибо за ролик!',x]),true,x);
 for(const x of ['Спасибо за ролик, золотые слова!','Золотая осень в вашем видео','Список идей ниже',''])assert.equal(ownerSaidGold([x]),false,x);
 assert.equal(ownerSaidGold([]),false);
});
test('only a live card becomes Gold',async()=>{
 const calls=[];const env={DB:{prepare:sql=>({bind:(...a)=>({run:async()=>{calls.push([sql,a]);return{meta:{changes:1}};}})})}};
 assert.equal(await markOwnerGold(env,'ugc_1',5),true);
 assert.match(calls[0][0],/NOT IN \('gold','refused','unfit','rival','owner'\) AND archived_at IS NULL/);
 assert.deepEqual(calls[0][1],['ugc_1',5]);
 assert.equal(await markOwnerGold(env,null),false);
});
