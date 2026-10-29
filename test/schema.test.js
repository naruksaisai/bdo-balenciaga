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

test('pool maxima must be whole numbers in range', () => {
  for (const bad of [0, -1, 1.5, 101, 'abc', '']) {
    const r = schema.validateSettings({ ...valid(), AUTO_EVENT_SHAI_MAX: bad });
    assert.ok(r.errors && r.errors.AUTO_EVENT_SHAI_MAX, `expected ${JSON.stringify(bad)} to fail`);
  }
  assert.equal(schema.validateField('AUTO_EVENT_SHAI_MAX', '7').value, 7, 'env strings are accepted');
});

test('emojis must be valid and distinct across pools', () => {
  let r = schema.validateSettings({ ...valid(), FLEX_EMOJI: 'flex' });
  assert.ok(r.errors.FLEX_EMOJI);
  r = schema.validateSettings({ ...valid(), FLEX_EMOJI: '⚔' }); // same as mainball minus FE0F
  assert.match(r.errors.FLEX_EMOJI, /Same emoji as Mainball/);
  r = schema.validateSettings({ ...valid(), FLEX_EMOJI: '<:flex:123456789012345678>' });
  assert.equal(r.ok, true);
});

test('unknown and missing keys are rejected', () => {
  const r = schema.validateSettings({ ...valid(), DISCORD_BOT_TOKEN: 'x' });
  assert.equal(r.errors.DISCORD_BOT_TOKEN, 'Unknown setting.');
  const missing = valid();
  delete missing.AUTO_EVENT_TITLE;
  assert.ok(schema.validateSettings(missing).errors.AUTO_EVENT_TITLE);
  assert.equal(schema.validateSettings(null).ok, false);
});

test('precedence: saved > environment > default, invalid levels fall through', () => {
  const r = schema.resolveSettings({
    saved: { AUTO_EVENT_TITLE: 'Saved title', AUTO_EVENT_FLEX_MAX: 999 },
    env: { AUTO_EVENT_TITLE: 'Env title', AUTO_EVENT_FLEX_MAX: '8', AUTO_EVENT_SHAI_MAX: 'junk', AUTO_EVENT_SCHEDULE: '20:00' },
  });
  assert.equal(r.values.AUTO_EVENT_TITLE, 'Saved title');
  assert.equal(r.sources.AUTO_EVENT_TITLE, 'saved');
  assert.equal(r.values.AUTO_EVENT_FLEX_MAX, 8, 'invalid saved value falls back to env');
  assert.equal(r.values.AUTO_EVENT_SHAI_MAX, schema.DEFAULTS.AUTO_EVENT_SHAI_MAX, 'invalid env falls back to default');
  assert.equal(r.values.AUTO_EVENT_SCHEDULE, '20:00');
  assert.equal(r.sources.AUTO_EVENT_DESCRIPTION, 'default');
  assert.equal(r.warnings.length, 2);
});

test('resolved emojis never collide even when levels disagree', () => {
  const r = schema.resolveSettings({ saved: { FLEX_EMOJI: '🛡️' }, env: {} });
  const values = schema.EMOJI_KEYS.map((k) => r.values[k].replace(/️/g, ''));
  assert.equal(new Set(values).size, values.length);
  assert.ok(r.warnings.some((w) => /duplicates/.test(w)));
});
