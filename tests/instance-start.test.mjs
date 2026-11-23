import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existingInstance } from '../server/core/instance.ts';

async function serve(t, body) {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('a free port allows normal startup', async () => {
  assert.equal(await existingInstance('127.0.0.1', 0), false);
});

test('a running healthy FlowMate is reused', async t => {
  const port = await serve(t, { ok: true, mode: 'lite', components: { database: 'ok', websocket_clients: 0 }, db_stats: {} });
  assert.equal(await existingInstance('127.0.0.1', port), true);
});

test('an unrelated occupied port is not treated as FlowMate', async t => {
  const port = await serve(t, { ok: true });
  await assert.rejects(existingInstance('127.0.0.1', port), /已被其他程序/);
});
