import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import JSZip from 'jszip';
import { extract } from '../dist/server/adapters/extraction.js';
import { useDbFile, runMigrations } from '../dist/server/core/db.js';
import { DOCUMENT_UPLOAD_MAX_BYTES } from '../dist/server/core/config.js';
import { decideType, getFilesService } from '../dist/server/modules/files/files.service.js';
import { FilesController } from '../dist/server/modules/files/files.controller.js';

test('identifies Office packages with their main entry past the old sniff limit', async () => {
  for (const [extension, mainEntry, kind] of [
    ['docx', 'word/document.xml', 'word'],
    ['xlsx', 'xl/workbook.xml', 'excel'],
    ['pptx', 'ppt/presentation.xml', 'ppt'],
  ]) {
    const zip = new JSZip();
    zip.file('media/large.bin', Buffer.alloc(2_100_000));
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file(mainEntry, '<document/>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    assert.ok(bytes.indexOf(mainEntry) > 2_000_000);
    const result = decideType('报告.' + extension, 'application/octet-stream', bytes);
    assert.equal(result.ok, true);
    assert.equal(result.kind, kind);
  }
  const archive = new JSZip().file('word/document.xml', 'not an Office package');
  assert.equal(decideType('archive.docx', '', await archive.generateAsync({ type: 'nodebuffer' })).ok, false);
  assert.equal(decideType('fake.xlsx', '', Buffer.from('plain text')).ok, false);
});

test('accepts documents through 50MB and reads UTF-8 CSV as a sheet', async () => {
  const bytes = Buffer.alloc(DOCUMENT_UPLOAD_MAX_BYTES + 1, 'a');
  assert.equal(decideType('报告.txt', '', bytes.subarray(0, -1)).ok, true);
  assert.equal(decideType('报告.txt', '', bytes).code, 'FILE_TOO_LARGE');
  const csv = Buffer.from('姓名,编号\n张三,001');
  assert.equal(decideType('客户.csv', '', csv).mime, 'text/csv');
  const result = await extract('客户.csv', csv, 'text/csv');
  assert.deepEqual(result.blocks[0].rows, [['姓名', '编号'], ['张三', '001']]);
});

test('signed PDF preview opens inline while downloads and HTML remain attachments', async () => {
  const db = useDbFile(':memory:');
  runMigrations(db);
  db.run("INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES('org','Org','org','now','now')");
  db.run("INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES('owner','owner@test','hash','Owner','now','now')");
  db.run("INSERT INTO memberships(id,organization_id,user_id,role,created_at) VALUES('owner-org','org','owner','member','now')");
  const actor = { userId: 'owner', orgId: 'org', role: 'member', displayName: 'Owner' };
  const samples = {
    pdf: { mime: 'application/pdf', kind: 'pdf', bytes: Buffer.from('%PDF-1.7\n%%EOF') },
    html: { mime: 'text/html', kind: 'html', bytes: Buffer.from('<html>Test</html>') },
  };
  const svc = getFilesService();
  svc.readObject = async (key) => samples[key].bytes;
  for (const [id, sample] of Object.entries(samples)) {
    db.run("INSERT INTO files(id,organization_id,space,owner_id,name,ext,mime,kind,created_at,updated_at) VALUES(?,'org','personal','owner',?,?,?,?,'now','now')", id, 'test.' + id, '.' + id, sample.mime, sample.kind);
    db.run("INSERT INTO file_versions(id,file_id,organization_id,version_no,object_key,sha256,size,mime,change_source,created_at) VALUES(?,?,'org',1,?,'hash',?,?,'seed','now')", id + '-version', id, id, sample.bytes.length, sample.mime);
    db.run("UPDATE files SET current_version_id=? WHERE id=?", id + '-version', id);
  }
  const pdf = await svc.preview(actor, 'pdf');
  assert.equal(pdf.note, '请在浏览器内置查看器打开下载链接');
  class TestModule {}
  Module({ controllers: [FilesController] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.use((req, _res, next) => {
    // 新开标签页的默认组织可能与当前工作区不同，这里要单独验证。
    req.actor = { ...actor, orgId: 'other-org', userId: req.headers['x-test-user'] ?? actor.userId };
    next();
  });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const open = async (url) => {
      const res = await fetch(new URL(url, base));
      assert.equal(res.status, 200);
      await res.arrayBuffer();
      return res.headers.get('content-disposition');
    };
    assert.match(await open(pdf.inline_url), /^inline;/);
    assert.match(await open(pdf.download_url), /^attachment;/);
    assert.match(await open((await svc.downloadUrl(actor, 'html')) + '&inline=1'), /^attachment;/);
    const other = await fetch(new URL(pdf.inline_url, base), { headers: { 'x-test-user': 'other' } });
    assert.equal(other.status, 403);
  } finally {
    await app.close();
  }
});
