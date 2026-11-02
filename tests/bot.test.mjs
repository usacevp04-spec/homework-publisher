import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const calls = [];
  let failChannel = false, failNotify = false, failAudit = false;
  const api = new Proxy({}, { get: (_, method) => async params => {
    calls.push({ method, ...params });
    if (String(params.chat_id) === '-1001234567890' && failChannel) throw new Error('Simulated timeout');
    if (method === 'sendMessage' && failNotify && params.text === 'Задание опубликовано.') throw new Error('Notification failed');
    if (method === 'sendMediaGroup') return params.media.map((_, i) => ({ message_id: i + 500 }));
    return { message_id: calls.length };
  } });
  const db = {
    async get(sql, params) { return sqlite.prepare(sql).get(params); },
    async run(sql, params) {
      if (failAudit && sql.startsWith('UPDATE homework_publications')) throw new Error('Audit unavailable');
      const result = sqlite.prepare(sql).run(params);
      return { rowsAffected: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid), rows: [] };
    },
  };
  const column = type => name => ({ name, type, primaryKey() { this.pk = true; return this; }, notNull() { this.required = true; return this; } });
  const table = (name, columns) => ({ name, columns });
  const context = vm.createContext({ console: { error() {} }, Date, Number, Set });
  const sdk = new vm.SyntheticModule(['api', 'db'], function () { this.setExport('api', api); this.setExport('db', db); }, { context });
  const sdkdb = new vm.SyntheticModule(['table', 'integer', 'text'], function () {
    this.setExport('table', table); this.setExport('integer', column('INTEGER')); this.setExport('text', column('TEXT'));
  }, { context });
  const cache = new Map();
  async function module(path) {
    path = resolve(path);
    if (cache.has(path)) return cache.get(path);
    const mod = new vm.SourceTextModule(await readFile(path, 'utf8'), { context, identifier: path });
    cache.set(path, mod);
    await mod.link((specifier, parent) => specifier === 'sdk' ? sdk : specifier === 'sdk/db' ? sdkdb : module(resolve(dirname(parent.identifier), specifier)));
    return mod;
  }
  const schema = await module('tgcloud/schema.js'); await schema.evaluate();
  for (const t of Object.values(schema.namespace)) {
    sqlite.exec(`CREATE TABLE ${t.name} (${Object.values(t.columns).map(c => `${c.name} ${c.type}${c.pk ? ' PRIMARY KEY' : ''}${c.required ? ' NOT NULL' : ''}`).join(', ')})`);
  }
  const bot = await module('tgcloud/lib/bot.js'); await bot.evaluate();
  const config = cache.get(resolve('tgcloud/lib/config.js')).namespace.config;
  config.allowedUserIds = [42, 43]; config.channelId = '-1001234567890';
  const model = cache.get(resolve('tgcloud/lib/model.js')).namespace;
  let mid = 0;
  const current = (uid = 42) => {
    const row = sqlite.prepare('SELECT * FROM homework_drafts WHERE user_id = ?').get(uid);
    return row && { ...row, data: JSON.parse(row.payload) };
  };
  const message = (fields, uid = 42) => bot.namespace.onMessage({ message_id: ++mid, from: { id: uid }, chat: { id: uid, type: 'private' }, ...fields });
  const click = (action, revision = current().revision, uid = 42) => bot.namespace.onCallback({ id: `q${++mid}`, from: { id: uid }, message: { chat: { id: uid, type: 'private' } }, data: `hw:${revision}:${action}` });
  const photo = id => ({ photo: [{ file_id: `file${id}`, file_unique_id: `unique${id}`, file_size: 100 }] });
  async function ready(count = 1) {
    await message({ text: '/start' }); await click('new'); await click('type_0');
    const date = model.localDate(config.utcOffsetMinutes).split('-').reverse().join('.');
    await message({ text: date }); await click('subject_0'); await message({ text: 'Страницы 10–12, № 5 <без HTML>' });
    await Promise.all(Array.from({ length: count }, (_, i) => message(photo(i))));
    await click('preview');
  }
  return { sqlite, calls, bot: bot.namespace, config, model, current, message, click, photo, ready,
    failChannel() { failChannel = true; }, failNotify() { failNotify = true; }, failAudit() { failAudit = true; } };
}

test('date boundaries, real calendar, timezone, caption validation', async () => {
  const f = await fixture();
  const now = Date.parse('2026-11-02T22:00:00Z');
  assert.equal(f.model.localDate(180, now), '2026-11-03');
  assert.equal(f.model.parseDate('02.11.2026', 180, now), null);
  assert.equal(f.model.parseDate('31.02.2027', 180, now), null);
  assert.equal(f.model.parseDate('29.02.2027', 180, now), null);
  assert.equal(f.model.parseDate('03.11.2027', 180, now), '2027-11-03');
  assert.equal(f.model.parseDate('04.11.2027', 180, now), null);
});

test('deny unlisted IDs, bots and non-private chats without creating drafts', async () => {
  const f = await fixture();
  await f.message({ text: '/start' }, 99);
  await f.message({ text: '/start', from: { id: 42, is_bot: true } });
  await f.message({ text: '/start', chat: { id: -42, type: 'group' } });
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM homework_drafts').get().n, 0);
  await f.bot.onCallback({ id: 'unauthorized', from: { id: 99 }, data: 'hw:0:new' });
  assert.equal(f.calls.at(-1).text, 'Доступ запрещён.');
});

test('full persisted flow, single photo publication, stale and repeated confirmations', async () => {
  const f = await fixture(); await f.ready();
  assert.equal(f.current().state, 'preview');
  const revision = f.current().revision;
  await Promise.all([f.click('publish', revision), f.click('publish', revision)]);
  await f.click('publish', revision);
  assert.equal(f.current().state, 'published');
  const sent = f.calls.filter(c => String(c.chat_id) === f.config.channelId);
  assert.equal(sent.length, 1); assert.equal(sent[0].method, 'sendPhoto');
  assert.match(sent[0].caption, /<без HTML>/); assert.equal(sent[0].parse_mode, undefined);
  assert.equal(f.sqlite.prepare('SELECT status FROM homework_publications').get().status, 'published');
  await f.click('new'); assert.equal(f.current().state, 'type');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM homework_publications').get().n, 1);
});

test('ten concurrent album updates retained, eleven rejected, album sent once', async () => {
  const f = await fixture(); await f.ready(10); await f.click('edit');
  await f.message(f.photo(11)); assert.equal(f.current().data.photos.length, 10);
  await f.message(f.photo(0)); assert.equal(f.current().data.photos.length, 10);
  await f.click('preview'); await f.click('publish');
  const sent = f.calls.filter(c => String(c.chat_id) === f.config.channelId);
  assert.equal(sent.length, 1); assert.equal(sent[0].media.length, 10);
  assert.equal(sent[0].method, 'sendMediaGroup');
  assert.ok(sent[0].media[0].caption); assert.equal(sent[0].media[1].caption, undefined);
});

test('ambiguous send is locked across /cancel, new, and repeated confirmation', async () => {
  const f = await fixture(); await f.ready(2); f.failChannel();
  await f.click('publish'); assert.equal(f.current().state, 'uncertain');
  await f.message({ text: '/cancel' }); await f.click('new'); await f.click('publish');
  assert.equal(f.current().state, 'uncertain');
  assert.equal(f.calls.filter(c => String(c.chat_id) === f.config.channelId).length, 1);
  assert.equal(f.sqlite.prepare('SELECT status FROM homework_publications').get().status, 'uncertain');
});

test('audit failure after Telegram accepted cannot cause resend', async () => {
  const f = await fixture(); await f.ready(); f.failAudit();
  await f.click('publish'); await f.click('publish');
  assert.equal(f.current().state, 'uncertain');
  assert.equal(f.calls.filter(c => String(c.chat_id) === f.config.channelId).length, 1);
});

test('notification failure preserves published state', async () => {
  const f = await fixture(); await f.ready(); f.failNotify();
  await assert.rejects(f.click('publish'), /Notification failed/);
  assert.equal(f.current().state, 'published');
  await f.click('publish');
  assert.equal(f.calls.filter(c => String(c.chat_id) === f.config.channelId).length, 1);
});

test('validation, resume, cancellation, stale buttons and user isolation', async () => {
  const f = await fixture(); await f.message({ text: '/start' }); await f.click('new');
  const old = f.current().revision; await f.click('type_0'); await f.click('cancel', old);
  assert.equal(f.current().state, 'date');
  await f.message({ text: '31.02.2030' }); assert.equal(f.current().state, 'date');
  await f.message({ text: '/draft' }); assert.equal(f.current().state, 'date');
  await f.message({ text: '/start' }, 43); assert.equal(f.current(43).state, 'empty');
  await f.message({ text: '/cancel' }); assert.equal(f.current().state, 'cancelled');
  await f.ready(); await f.click('edit'); await f.click('clear'); await f.click('preview');
  assert.equal(f.current().state, 'photos');
  await f.message({ document: { file_id: 'document' } }); assert.equal(f.current().data.photos.length, 0);
  await f.message({ photo: [{ file_id: 'large', file_unique_id: 'large', file_size: 11 * 1024 * 1024 }] });
  assert.equal(f.current().data.photos.length, 0);
});

test('missing channel and invalid stored draft cannot publish', async () => {
  const f = await fixture(); await f.ready(); f.config.channelId = '';
  await f.click('publish'); assert.equal(f.current().state, 'preview');
  f.config.channelId = '-1001234567890';
  const data = f.current().data; data.title = '';
  f.sqlite.prepare('UPDATE homework_drafts SET payload = ?').run(JSON.stringify(data));
  await f.click('publish'); assert.equal(f.current().state, 'preview');
  assert.equal(f.calls.filter(c => String(c.chat_id) === f.config.channelId).length, 0);
});

test('empty allowlist denies access and crafted callback cannot use another user draft', async () => {
  const f = await fixture(); await f.ready();
  const revision = f.current().revision;
  await f.click('publish', revision, 43);
  assert.equal(f.current().state, 'preview');
  assert.equal(f.calls.filter(c => String(c.chat_id) === f.config.channelId).length, 0);
  f.config.allowedUserIds = [];
  await f.click('publish', revision); await f.message({ text: '/cancel' });
  assert.equal(f.current().state, 'preview');
});

test('title boundaries and delivery replay are validated without losing the draft', async () => {
  const f = await fixture();
  await f.message({ text: '/start' }); await f.click('new'); await f.click('type_0');
  await f.message({ text: f.model.localDate(180).split('-').reverse().join('.') }); await f.click('subject_0');
  await f.message({ text: ' ' }); await f.message({ text: 'x'.repeat(301) }); await f.message({ text: 'a\nb' });
  assert.equal(f.current().state, 'title');
  await f.message({ text: 'x'.repeat(300) }); assert.equal(f.current().state, 'photos');
  const input = { message_id: 90000, from: { id: 42 }, chat: { id: 42, type: 'private' }, ...f.photo('replay') };
  await Promise.all([f.bot.onMessage(input), f.bot.onMessage(input)]);
  assert.equal(f.current().data.photos.length, 1);
  const revision = f.current().revision;
  await f.bot.onMessage(input);
  assert.equal(f.current().revision, revision);
});
