const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../src/settings/schema');

const valid = () => ({ ...schema.DEFAULTS });

test('defaults are themselves valid', () => {
  assert.deepEqual(schema.validateSettings(valid()), { ok: true, value: schema.DEFAULTS });
});

test('time is validated and normalized', () => {
  assert.equal(schema.normalizeTime('9:05'), '09:05');
  assert.equal(schema.normalizeTime(' 21:30 '), '21:30');
  for (const bad of ['24:00', '12:60', '1230', '12:5', 'ab:cd', '', 1230]) {
    assert.equal(schema.normalizeTime(bad), null, String(bad));
  }
  const r = schema.validateSettings({ ...valid(), AUTO_EVENT_SCHEDULE: '25:00' });
  assert.equal(r.ok, false);
  assert.match(r.errors.AUTO_EVENT_SCHEDULE, /HH:MM/);
});

test('title is required and trimmed; description length is capped', () => {
  let r = schema.validateSettings({ ...valid(), AUTO_EVENT_TITLE: '   ' });
  assert.match(r.errors.AUTO_EVENT_TITLE, /required/);
  r = schema.validateSettings({ ...valid(), AUTO_EVENT_TITLE: '  Raid  ', AUTO_EVENT_DESCRIPTION: 'a\r\nb ' });
  assert.equal(r.value.AUTO_EVENT_TITLE, 'Raid');
  assert.equal(r.value.AUTO_EVENT_DESCRIPTION, 'a\nb');
  r = schema.validateSettings({ ...valid(), AUTO_EVENT_DESCRIPTION: 'x'.repeat(4001) });
  assert.ok(r.errors.AUTO_EVENT_DESCRIPTION);
});

test('legacy pool maxima are whole numbers in range', () => {
  for (const bad of [0, -1, 1.5, 101, 'abc', '']) {
    assert.ok(schema.validateField('AUTO_EVENT_SHAI_MAX', bad).error, `expected ${JSON.stringify(bad)} to fail`);
  }
  assert.equal(schema.validateField('AUTO_EVENT_SHAI_MAX', '7').value, 7, 'env strings are accepted');
});

test('the Donkey emoji must be a single emoji', () => {
  let r = schema.validateSettings({ ...valid(), DONKEY_EMOJI: 'donkey' });
  assert.ok(r.errors.DONKEY_EMOJI);
  r = schema.validateSettings({ ...valid(), DONKEY_EMOJI: '<:mule:123456789012345678>' });
  assert.equal(r.ok, true);
});

test('unknown and missing keys are rejected; role keys are no longer settings', () => {
  const r = schema.validateSettings({ ...valid(), DISCORD_BOT_TOKEN: 'x', MAINBALL_EMOJI: '⚔️' });
  assert.equal(r.errors.DISCORD_BOT_TOKEN, 'Unknown setting.');
  assert.equal(r.errors.MAINBALL_EMOJI, 'Unknown setting.');
  const missing = valid();
  delete missing.AUTO_EVENT_TITLE;
  assert.ok(schema.validateSettings(missing).errors.AUTO_EVENT_TITLE);
  assert.equal(schema.validateSettings(null).ok, false);
});

test('precedence: saved > environment > default, invalid levels fall through', () => {
  const r = schema.resolveSettings({
    saved: { AUTO_EVENT_TITLE: 'Saved title', AUTO_EVENT_SCHEDULE: '99:99' },
    env: { AUTO_EVENT_TITLE: 'Env title', AUTO_EVENT_SCHEDULE: '20:00', DONKEY_EMOJI: 'junk' },
  });
  assert.equal(r.values.AUTO_EVENT_TITLE, 'Saved title');
  assert.equal(r.sources.AUTO_EVENT_TITLE, 'saved');
  assert.equal(r.values.AUTO_EVENT_SCHEDULE, '20:00', 'invalid saved value falls back to env');
  assert.equal(r.values.DONKEY_EMOJI, schema.DEFAULTS.DONKEY_EMOJI, 'invalid env falls back to default');
  assert.equal(r.sources.AUTO_EVENT_DESCRIPTION, 'default');
  assert.equal(r.warnings.length, 2);
});

test('built-in roles are seeded from older saved values, then env, then defaults', () => {
  const roles = schema.resolveLegacyRoles({
    saved: { AUTO_EVENT_FLEX_MAX: 999, SHAI_EMOJI: '🔥' },
    env: { AUTO_EVENT_FLEX_MAX: '8', AUTO_EVENT_SHAI_MAX: 'junk' },
  });
  assert.deepEqual(roles.map((r) => r.key), ['mainball', 'def-team', 'commander', 'shai', 'flex']);
  const byKey = Object.fromEntries(roles.map((r) => [r.key, r]));
  assert.equal(byKey.flex.max, 8);
  assert.equal(byKey.shai.max, 3);
  assert.equal(byKey.shai.emoji, '🔥');
  assert.equal(byKey.mainball.label, 'Mainball');
});
