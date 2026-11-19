import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { build } from 'vite';

test('locked Node / SQLite WAL, rollback, unique IDs and reopen persistence', () => {
  assert.equal(process.version, 'v24.19.0');
  const directory = resolve('.local/runtime-probes', randomUUID()); mkdirSync(directory, { recursive: true });
  const file = resolve(directory, 'probe.sqlite');
  let db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE probe (id TEXT PRIMARY KEY, amount TEXT NOT NULL); BEGIN IMMEDIATE;');
    db.prepare('INSERT INTO probe VALUES (?,?)').run('payment-1', '33000000000'); db.exec('COMMIT');
    db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO probe VALUES (?,?)').run('payment-2', '25000000000'); db.exec('ROLLBACK');
    assert.throws(() => db.prepare('INSERT INTO probe VALUES (?,?)').run('payment-1', '1'));
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    db.close(); db = new DatabaseSync(file);
    assert.equal(db.prepare('SELECT amount FROM probe WHERE id=?').get('payment-1')!.amount, '33000000000');
    assert.equal(db.prepare('SELECT count(*) AS n FROM probe').get()!.n, 1);
    console.log('SQLite runtime:', db.prepare('SELECT sqlite_version() AS version').get()!.version);
  } finally { db.close(); }
});
test('Fastify schema rejects Number amounts and preserves decimal strings', async () => {
    // Financial inputs must not be silently coerced to strings.
    const strict = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
    strict.post('/probe', { schema: { body: { type: 'object', additionalProperties: false, required: ['amount'], properties: { amount: { type: 'string', pattern: '^[1-9][0-9]*$' } } } } }, async request => request.body);
    try {
      assert.equal((await strict.inject({ method: 'POST', url: '/probe', payload: { amount: 33000000000 } })).statusCode, 400);
      assert.equal((await strict.inject({ method: 'POST', url: '/probe', payload: { amount: '33000000000', role: 'governor' } })).statusCode, 400);
      const reply = await strict.inject({ method: 'POST', url: '/probe', payload: { amount: '33000000000' } });
      assert.equal(reply.statusCode, 200); assert.equal(reply.json().amount, '33000000000');
    } finally { await strict.close(); }
});
test('Vite compiles TypeScript domain entry without filesystem output', async () => {
  const result = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: resolve('packages/domain/ledger.ts'), formats: ['es'], fileName: 'probe' } } });
  const bundles = Array.isArray(result) ? result : [result];
  assert(bundles.some(bundle => 'output' in bundle && bundle.output.some(item => item.type === 'chunk' && item.code.includes('POOL_INSOLVENT'))));
});
