import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useDbFile, runMigrations } from '../dist/server/core/db.js';
import { FilesService } from '../dist/server/modules/files/files.service.js';

test('trash restoration records recent files and permanent deletion revokes access and restoration', async () => {
  const db = useDbFile(':memory:');
  runMigrations(db);
  db.run("INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES('org','Org','org','now','now')");
  for (const id of ['owner','other']) {
    db.run("INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES(?,?,'hash',?,'now','now')", id, id+'@test', id);
    db.run("INSERT INTO memberships(id,organization_id,user_id,role,created_at) VALUES(?,'org',?,'member','now')", id+'-membership', id);
  }
  const actor = { userId:'owner', orgId:'org', role:'member', displayName:'Owner' };
  const other = { ...actor, userId:'other' };
  const files = new FilesService(); files.onModuleInit();
  const folder = (id,parent=null) => db.run("INSERT INTO folders(id,organization_id,space,owner_id,parent_id,name,created_at,updated_at) VALUES(?,'org','personal','owner',?,?,'now','now')", id,parent,id);
  const file = (id,folderId=null) => db.run("INSERT INTO files(id,organization_id,space,owner_id,folder_id,name,ext,mime,kind,created_at,updated_at) VALUES(?,'org','personal','owner',?,?,'md','text/markdown','markdown','now','now')",id,folderId,id+'.md');
  folder('parent'); db.run("UPDATE folders SET is_space=1 WHERE id='parent'"); file('restore','parent');
  await files.trash(actor,{kind:'file',id:'restore'});
  await files.trash(actor,{kind:'folder',id:'parent'});
  const restored = await files.restoreWithNote(actor,{kind:'file',id:'restore'});
  assert.match(restored.note,/最近/);
  assert.ok((await files.recent(actor)).some(row=>row.id==='restore'));
  await assert.rejects(files.permanentDelete(actor,{kind:'file',id:'restore'}));
  await files.trash(actor,{kind:'file',id:'restore'});
  await assert.rejects(files.permanentDelete(other,{kind:'file',id:'restore'}));
  await files.permanentDelete(actor,{kind:'file',id:'restore'});
  assert.equal(db.get('SELECT status FROM files WHERE id=?','restore').status,'permanently_deleted');
  await assert.rejects(files.restoreWithNote(actor,{kind:'file',id:'restore'}));
  await assert.rejects(files.getFile(actor,'restore'));
  assert.ok(!(await files.trashList(actor)).files.some(row=>row.id==='restore'));
  folder('child','parent'); file('nested','child');
  db.run("INSERT INTO file_versions(id,file_id,organization_id,version_no,object_key,sha256,size,mime,change_source,created_at) VALUES('version','nested','org',1,'object','hash',0,'text/markdown','seed','now')");
  await files.permanentDelete(actor,{kind:'folder',id:'parent'});
  assert.equal(db.get("SELECT status FROM files WHERE id='nested'").status,'permanently_deleted');
  assert.ok(db.get("SELECT permanently_deleted_at FROM folders WHERE id='child'").permanently_deleted_at);
  assert.ok(!(await files.trashList(actor)).folders.some(row=>['child','parent'].includes(row.id)));
  await assert.rejects(files.restoreWithNote(actor,{kind:'folder',id:'parent'}));
  await assert.rejects(files.restoreWithNote(actor,{kind:'folder',id:'child'}));
  assert.throws(()=>files.resolveDownloadTarget('object','version','nested'),/永久删除/);
});
