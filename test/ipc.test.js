const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUiMessage, serializeForUi } = require('../src/desktop/ipc');
const { redact } = require('../src/utils/logger');

test('accepts whitelisted messages', () => {
  assert.equal(parseUiMessage('{"type":"ready"}').ok, true);
  assert.equal(parseUiMessage('{"type":"setHosting","id":3,"enabled":true}').ok, true);
  assert.equal(parseUiMessage(JSON.stringify(saveMsg())).ok, true);
  assert.equal(parseUiMessage('{"type":"createEventNow","id":2}').ok, true);
  assert.equal(parseUiMessage('{"type":"createEventNow","id":2,"title":"x"}').ok, false);
  assert.equal(parseUiMessage('{"type":"createEventNow"}').ok, false, 'needs an id');
});

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
function saveMsg(o = {}) {
  return {
    type: 'saveSettings',
    id: 1,
    settings: { AUTO_EVENT_TITLE: 'x', DONKEY_EMOJI: '🐴' },
    roles: [{ key: 'mainball', label: 'Mainball', emoji: '⚔️', max: 20 }, { key: '', label: 'New', emoji: '🏹', max: 5 }],
    days: Object.fromEntries(DAYS.map((d) => [d, d !== 'friday'])),
    ...o,
  };
}

test('saveSettings roles and days must have the exact shape', () => {
  const role = { key: 'k', label: 'L', emoji: '🏹', max: 5 };
  const days = saveMsg().days;
  const bad = [
    { roles: undefined },
    { roles: 'mainball' },
    { roles: [{ key: 'k', label: 'L', emoji: '🏹' }] },                       // missing max
    { roles: [{ ...role, extra: 1 }] },                                        // unknown field
    { roles: [{ ...role, label: { x: 1 } }] },
    { roles: [{ ...role, label: 'x'.repeat(101) }] },
    { roles: Array.from({ length: 21 }, () => role) },                         // over the role limit
    { days: undefined },
    { days: { ...days, funday: true } },
    { days: { ...days, friday: 'no' } },
    { days: Object.fromEntries(Object.entries(days).slice(1)) },              // a day missing
  ];
  for (const o of bad) assert.equal(parseUiMessage(JSON.stringify(saveMsg(o))).ok, false, JSON.stringify(o).slice(0, 80));
});

test('rejects malformed, unknown and out-of-shape messages', () => {
  const bad = [
    'not json',
    '[]',
    '{"type":"runShell","id":1}',
    '{"type":"__proto__"}',
    '{"type":"setHosting","enabled":true}',              // request without id
    '{"type":"setHosting","id":1,"enabled":"yes"}',       // wrong type
    '{"type":"ready","extra":1}',                         // unexpected field
    '{"type":"saveSettings","id":1,"settings":{"DISCORD_BOT_TOKEN":"x"}}', // connection keys never accepted
    '{"type":"saveSettings","id":1,"settings":{"AUTO_EVENT_TITLE":{"nested":1}}}',
    '{"type":"log","level":"debug","message":"x"}',
    JSON.stringify({ type: 'log', level: 'info', message: 'x'.repeat(70 * 1024) }),
  ];
  for (const line of bad) assert.equal(parseUiMessage(line).ok, false, line.slice(0, 80));
});

test('a rejected request still carries its id so the UI gets an answer', () => {
  assert.equal(parseUiMessage('{"type":"setHosting","id":7,"enabled":1}').id, 7);
});

test('UI-bound JSON is ASCII-only and round-trips unicode', () => {
  const msg = { type: 'settings', values: { MAINBALL_EMOJI: '⚔️', AUTO_EVENT_TITLE: 'Raid — tonight' } };
  const line = serializeForUi(msg);
  assert.match(line, /^[\x00-\x7f]*$/);
  assert.deepEqual(JSON.parse(line), msg);
});

test('the bot token never reaches the UI or logs', () => {
  const prev = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = 'secret-token-value-123';
  try {
    assert.ok(!serializeForUi({ type: 'response', error: 'failed with secret-token-value-123' }).includes('secret-token'));
    // Built at runtime so the repo never contains a token-shaped literal
    // (GitHub push protection rejects even fake ones).
    const tokenShaped = ['A'.repeat(26), 'B'.repeat(6), 'C'.repeat(30)].join('.');
    assert.equal(redact(`token ${tokenShaped} leaked`), 'token [REDACTED] leaked');
  } finally {
    if (prev === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = prev;
  }
});
