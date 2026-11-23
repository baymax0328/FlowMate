import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useDbFile, runMigrations } from '../dist/server/core/db.js';
import { FilesService } from '../dist/server/modules/files/files.service.js';
import { MessagesService } from '../dist/server/modules/messages/messages.service.js';

test('file sharing grants view access atomically, delivers cards, and records recent opens', async () => {
  const db = useDbFile(':memory:');
  runMigrations(db);
  db.run("INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES('org','Org','org','now','now')");
  const users = ['sender', 'editor', 'viewer', 'peer'].map(userId => ({ userId, role: 'member', orgId: 'org', displayName: userId }));
  const [sender, editor, viewer, peer] = users;
  for (const { userId } of users) {
    db.run("INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES(?,?,'hash',?,'now','now')",
      userId, userId + '@test', userId);
    db.run("INSERT INTO memberships(id,organization_id,user_id,role,created_at) VALUES(?,'org',?,'member','now')",
      'member-' + userId, userId);
  }

  const files = new FilesService();
  files.onModuleInit();
  const messages = new MessagesService();
  for (const fileId of ['file', 'restricted']) {
    db.run(`INSERT INTO files(id,organization_id,space,owner_id,name,ext,mime,kind,created_at,updated_at)
      VALUES(?,'org','personal','sender',?,'.md','text/markdown','markdown','now','now')`, fileId, fileId + '.md');
    db.run(`INSERT INTO file_versions(id,file_id,organization_id,version_no,object_key,sha256,size,mime,change_source,created_at)
      VALUES(?,?,'org',1,?,'hash',0,'text/markdown','seed','now')`, fileId + '-version', fileId, fileId + '-object');
    db.run('UPDATE files SET current_version_id=? WHERE id=?', fileId + '-version', fileId);
  }

  const group = await messages.createConversation(sender, { type: 'project', name: 'Share test', member_ids: [editor.userId, viewer.userId] });
  await files.aclSet(sender, { kind: 'file', id: 'file', grants: [{ principal_type: 'user', principal_id: editor.userId, permission: 'editor' }] });
  await files.aclSet(sender, { kind: 'file', id: 'restricted', grants: [{ principal_type: 'user', principal_id: viewer.userId, permission: 'viewer', effect: 'deny' }] });

  const target = { conversation_id: group.id, client_msg_id: 'group-share' };
  await assert.rejects(messages.shareFile(sender, 'restricted', target), /已被拒绝/);
  await assert.rejects(files.getFile(editor, 'restricted'));
  assert.equal((await messages.messages(editor, group.id)).items.length, 0);

  const sent = await messages.shareFile(sender, 'file', target);
  assert.equal((await messages.shareFile(sender, 'file', target)).id, sent.id);
  assert.equal((await files.getFile(editor, 'file')).my_permission, 'editor');
  assert.equal((await files.getFile(viewer, 'file')).my_permission, 'viewer');
  assert.equal((await files.recent(viewer))[0].id, 'file');
  const [received] = (await messages.messages(viewer, group.id)).items;
  assert.equal(received.card_type, 'file_version');
  assert.equal(received.card.target_path, '/workspace?section=recent&focus=file');

  await assert.rejects(messages.shareFile(viewer, 'file', { user_id: peer.userId, client_msg_id: 'forbidden' }));
  assert.equal((await messages.list(peer)).length, 0);
  const direct = await messages.shareFile(sender, 'restricted', { user_id: peer.userId, client_msg_id: 'direct-share' });
  assert.equal((await messages.messages(peer, direct.conversation_id)).items[0].card.access, 'granted');
  assert.equal((await files.getFile(peer, 'restricted')).my_permission, 'viewer');
});
