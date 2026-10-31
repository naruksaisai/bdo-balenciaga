const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRoles, normalizeRoles, MAX_ROLES } = require('../src/settings/roles');
const schema = require('../src/settings/schema');

const ROLES = schema.resolveLegacyRoles({});
const role = (o = {}) => ({ key: '', label: 'Archer', emoji: '🏹', max: 4, ...o });

test('the built-in roles are valid', () => {
  const r = validateRoles(ROLES, { donkeyEmoji: '🐴' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, ROLES);
});

test('new roles get a key from their name; existing keys never change', () => {
  const r = validateRoles([
    { ...ROLES[0], label: 'Main Ball Team' },
    role({ label: 'Healer & Support' }),
    role({ label: 'Healer/Support', emoji: '🩹' }),
    role({ label: 'Donkey', emoji: '🔥' }),
    role({ label: '弓兵', emoji: '🎯' }),
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((x) => x.key), ['mainball', 'healer-support', 'healer-support-2', 'donkey-2', 'role']);
  assert.equal(r.value[0].label, 'Main Ball Team', 'rename keeps the key');
});

test('a forged or duplicate key is replaced, never reused', () => {
  const r = validateRoles([role({ key: 'x' }), role({ key: 'x', label: 'Other', emoji: '🔥' }), role({ key: 'donkey', label: 'D', emoji: '🎯' }), role({ key: '../evil', label: 'E', emoji: '⭐' })]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((x) => x.key), ['x', 'other', 'd', 'e']);
});

test('names, maxima and emojis are validated per row', () => {
  const r = validateRoles([
    role({ label: '  ' }),
    role({ label: 'x'.repeat(33), emoji: '🔥' }),
    role({ label: 'Max', emoji: '🎯', max: 0 }),
    role({ label: 'Emoji', emoji: 'bow' }),
    role({ label: 'archer', emoji: '⭐' }),
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.errors['roles.0.label']);
  assert.ok(r.errors['roles.1.label']);
  assert.ok(r.errors['roles.2.max']);
  assert.ok(r.errors['roles.3.emoji']);
  assert.equal(r.errors['roles.4.label'], undefined, 'row 0 had no valid name to clash with');
});

test('names and emojis must be distinct, including the Donkey emoji', () => {
  let r = validateRoles([role(), role({ label: 'ARCHER', emoji: '🔥' })]);
  assert.match(r.errors['roles.1.label'], /already/);
  r = validateRoles([role(), role({ label: 'Bow', emoji: '🏹' })]);
  assert.match(r.errors['roles.1.emoji'], /Same emoji as Archer/);
  r = validateRoles([role({ emoji: '🐴' })], { donkeyEmoji: '🐴' });
  assert.match(r.errors['roles.0.emoji'], /Donkey/);
});

test('between 1 and the Discord reaction limit of roles', () => {
  assert.match(validateRoles([]).errors.roles, /at least one/);
  const many = Array.from({ length: MAX_ROLES + 1 }, (_, i) => role({ label: `R${i}`, emoji: schema.BUILTIN_EMOJIS[i] }));
  assert.match(validateRoles(many).errors.roles, /At most/);
  assert.equal(validateRoles(null).ok, false);
});

test('stored role lists are repaired, falling back when nothing is left', () => {
  assert.deepEqual(normalizeRoles(undefined, ROLES), ROLES);
  assert.deepEqual(normalizeRoles([{ key: 'bad' }], ROLES), ROLES);
  const kept = normalizeRoles([{ key: 'a', label: 'A', emoji: '🔥', max: 2 }, { key: 'a', label: 'B', emoji: '🎯', max: 2 }], ROLES);
  assert.deepEqual(kept, [{ key: 'a', label: 'A', emoji: '🔥', max: 2 }]);
});
