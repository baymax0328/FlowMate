import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namedWorkspaceFileIds } from '../dist/server/modules/orchestrator/scheduler.runner.js';

const entries = [
  {name:'a.txt',file_id:'text'}, {name:'b.md',file_id:'markdown'},
  {name:'c.pdf',file_id:'pdf'}, {name:'d.xlsx',file_id:'excel'},
  {name:'古诗六首.docx',file_id:'word'}, {name:'任务安排.html',file_id:'html'},
  {name:'古诗六首',kind:'folder'},
];
test('named DOCX and HTML take precedence over the first four files',()=>{
  assert.deepEqual(namedWorkspaceFileIds(entries,'古诗六首.docx下有几首古诗？'),['word']);
  assert.deepEqual(namedWorkspaceFileIds(entries,'古诗六首分别是？'),['word']);
  assert.deepEqual(namedWorkspaceFileIds(entries,'任务安排里给我安排了什么任务'),['html']);
  assert.deepEqual(namedWorkspaceFileIds(entries,'请对比古诗六首.docx和任务安排.html'),['word','html']);
  assert.deepEqual(namedWorkspaceFileIds(entries,'工作区有多少文件？'),[]);
});
