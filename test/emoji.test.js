const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEmoji, reactionMatches } = require('../src/utils/emoji');

test('parses unicode emoji, including ZWJ, skin tone, flag and keycap sequences', () => {
  for (const e of ['⚔️', '⚔', '🛡️', '👑', '🧙‍♂️', '👍🏽', '🇰🇷', '1️⃣', '🏳️‍🌈']) {
    const p = parseEmoji(e);
    assert.ok(p, `expected ${e} to parse`);
    assert.equal(p.kind, 'unicode');
  }
});

test('rejects text, multiple emojis and empty input', () => {
  for (const bad of ['', '   ', 'abc', 'x⚔️', '⚔️ ⚔️', '⚔️⚔️', '1', ':sword:', null, 42]) {
    assert.equal(parseEmoji(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('parses static and animated Discord custom emojis', () => {
  assert.deepEqual(parseEmoji(' <:raid:123456789012345678> '), {
    kind: 'custom', value: '<:raid:123456789012345678>', name: 'raid', id: '123456789012345678', animated: false, key: 'id:123456789012345678',
  });
  assert.equal(parseEmoji('<a:dance:123456789012345678>').animated, true);
  assert.equal(parseEmoji('<:x:123456789012345678>'), null, 'name too short');
  assert.equal(parseEmoji('<:raid:12>'), null, 'id too short');
});

test('variation selector does not affect identity', () => {
  assert.equal(parseEmoji('⚔️').key, parseEmoji('⚔').key);
});

test('reactionMatches handles FE0F differences, custom ids and legacy name config', () => {
  assert.ok(reactionMatches('⚔️', { id: null, name: '⚔' }));
  assert.ok(reactionMatches('⚔', { id: null, name: '⚔️' }));
  assert.ok(!reactionMatches('⚔️', { id: null, name: '🛡️' }));
  assert.ok(reactionMatches('<:raid:123456789012345678>', { id: '123456789012345678', name: 'raid' }));
  assert.ok(reactionMatches('<a:raid:123456789012345678>', { id: '123456789012345678', name: 'renamed' }));
  assert.ok(!reactionMatches('<:raid:123456789012345678>', { id: null, name: 'raid' }));
  assert.ok(reactionMatches('raid', { id: '1', name: 'raid' }), 'legacy bare-name config');
});
