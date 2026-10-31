// The event's role list (pools people react to join). Pure — validation, key
// assignment and repair — so it can be unit tested directly.
//
// A role is { key, label, emoji, max }. `key` is the stable id used in pools,
// participants and per-day limits; renaming a role only changes its label.
// Donkey (overflow) is not a role: it is always present and has no limit.
const { parseEmoji } = require('../utils/emoji');
const { validateMax, validateEmoji } = require('./schema');

const MAX_ROLES = 20; // Discord allows 20 distinct reactions per message
const LABEL_MAX = 32;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED_KEYS = ['donkey'];

function slugify(label) {
  const s = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s || 'role';
}

function uniqueKey(base, taken) {
  let key = base;
  for (let i = 2; taken.has(key) || RESERVED_KEYS.includes(key); i++) key = `${base}-${i}`;
  return key;
}

function validateLabel(value) {
  if (typeof value !== 'string' || !value.trim()) return { error: 'Name is required.' };
  if (value.trim().length > LABEL_MAX) return { error: `Name must be at most ${LABEL_MAX} characters.` };
  return { value: value.trim() };
}

// Validates the role list from the UI. Roles arriving with an empty or unusable
// key are new and get one derived from their label.
// donkeyEmoji: the overflow emoji, which must not clash with any role.
// Returns { ok:true, value:[role] } or { ok:false, errors:{ 'roles.<i>.<field>': msg, roles?: msg } }.
function validateRoles(input, { donkeyEmoji } = {}) {
  if (!Array.isArray(input)) return { ok: false, errors: { roles: 'Roles must be a list.' } };
  const errors = {};
  if (input.length < 1) errors.roles = 'Add at least one role.';
  if (input.length > MAX_ROLES) errors.roles = `At most ${MAX_ROLES} roles (Discord's reaction limit).`;

  const labels = new Map();
  const emojis = new Map();
  if (donkeyEmoji && parseEmoji(donkeyEmoji)) emojis.set(parseEmoji(donkeyEmoji).key, 'Donkey');
  const out = [];
  input.forEach((r, i) => {
    const role = r && typeof r === 'object' ? r : {};
    const label = validateLabel(role.label);
    const max = validateMax(role.max);
    const emoji = validateEmoji(role.emoji);
    if (label.error) errors[`roles.${i}.label`] = label.error;
    else if (labels.has(label.value.toLowerCase())) errors[`roles.${i}.label`] = 'Another role already has this name.';
    else labels.set(label.value.toLowerCase(), i);
    if (max.error) errors[`roles.${i}.max`] = max.error;
    if (emoji.error) errors[`roles.${i}.emoji`] = emoji.error;
    else {
      const k = parseEmoji(emoji.value).key;
      if (emojis.has(k)) errors[`roles.${i}.emoji`] = `Same emoji as ${emojis.get(k)}.`;
      else emojis.set(k, label.value || `role ${i + 1}`);
    }
    out.push({ key: typeof role.key === 'string' ? role.key : '', label: label.value, emoji: emoji.value, max: max.value });
  });
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: assignKeys(out) };
}

// Keeps valid, unique keys; gives every other role a fresh one.
function assignKeys(roles) {
  const taken = new Set();
  const keep = roles.map((r) => {
    const ok = KEY_RE.test(r.key) && !RESERVED_KEYS.includes(r.key) && !taken.has(r.key);
    if (ok) taken.add(r.key);
    return ok;
  });
  return roles.map((r, i) => {
    if (keep[i]) return { ...r };
    const key = uniqueKey(slugify(r.label), taken);
    taken.add(key);
    return { ...r, key };
  });
}

// Repairs a stored role list (schedule.json or a leader's broadcast): drops
// broken or duplicate entries one by one; falls back when nothing usable is left.
function normalizeRoles(raw, fallback) {
  if (!Array.isArray(raw)) return fallback.map((r) => ({ ...r }));
  const out = [];
  const keys = new Set();
  const emojis = new Set();
  for (const r of raw.slice(0, MAX_ROLES)) {
    if (!r || typeof r !== 'object') continue;
    const label = validateLabel(r.label);
    const max = validateMax(r.max);
    const emoji = validateEmoji(r.emoji);
    if (label.error || max.error || emoji.error) continue;
    if (!KEY_RE.test(r.key) || RESERVED_KEYS.includes(r.key) || keys.has(r.key)) continue;
    const ek = parseEmoji(emoji.value).key;
    if (emojis.has(ek)) continue;
    keys.add(r.key);
    emojis.add(ek);
    out.push({ key: r.key, label: label.value, emoji: emoji.value, max: max.value });
  }
  return out.length ? out : fallback.map((r) => ({ ...r }));
}

module.exports = { MAX_ROLES, LABEL_MAX, validateRoles, assignKeys, normalizeRoles, slugify };
