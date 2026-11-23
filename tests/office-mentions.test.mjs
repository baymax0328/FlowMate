import test from 'node:test';
import assert from 'node:assert/strict';
import {activeMention,insertMention} from '../src/features/agent/mentions.ts';
test('typed @ can mention the same member repeatedly',()=>{
 let t='@张三 请确认 @张';const r=activeMention(t,t.length);assert.equal(r.query,'张');const next=insertMention(t,r.start,r.end,'张三');assert.equal(next.text,'@张三 请确认 @张三 ');assert.equal(activeMention(next.text,next.caret),null);
 const s=next.text+'@李';assert.equal(activeMention(s,s.length).query,'李');
});
test('mention replacement at cursor preserves following text',()=>{
 const text='讨论 @王 后续内容';const caret=text.indexOf(' 后续');const r=activeMention(text,caret);const next=insertMention(text,r.start,r.end,'王小明');assert.equal(next.text,'讨论 @王小明  后续内容');assert.equal(next.text.slice(0,next.caret),'讨论 @王小明 ');
 assert.equal(activeMention('普通消息',4),null);assert.equal(activeMention('你好\n@张',5).query,'张');
});
