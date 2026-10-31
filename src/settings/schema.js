// User-editable settings: keys, defaults, validation and precedence. Pure — no
// file or Discord access — so it can be unit tested directly.
//
// Roles (pools) are not settings any more: they live in schedule.json so they
// sync to standby nodes (see settings/roles.js). The per-role keys below remain
// only as the source of the built-in roles' defaults (build env, .env, and
// values saved by older versions) when schedule.json has no role list yet.
const { parseEmoji } = require('../utils/emoji');

const POOLS = [
  { key: 'mainball',  label: 'Mainball',  maxKey: 'AUTO_EVENT_MAINBALL_MAX',  emojiKey: 'MAINBALL_EMOJI',  defaultMax: 20, defaultEmoji: '⚔️' },
  { key: 'def-team',  label: 'Def Team',  maxKey: 'AUTO_EVENT_DEF_TEAM_MAX',  emojiKey: 'DEF_TEAM_EMOJI',  defaultMax: 10, defaultEmoji: '🛡️' },
  { key: 'commander', label: 'Commander', maxKey: 'AUTO_EVENT_COMMANDER_MAX', emojiKey: 'COMMANDER_EMOJI', defaultMax: 2,  defaultEmoji: '👑' },
  { key: 'shai',      label: 'Shai',      maxKey: 'AUTO_EVENT_SHAI_MAX',      emojiKey: 'SHAI_EMOJI',      defaultMax: 3,  defaultEmoji: '🎵' },
  { key: 'flex',      label: 'Flex',      maxKey: 'AUTO_EVENT_FLEX_MAX',      emojiKey: 'FLEX_EMOJI',      defaultMax: 5,  defaultEmoji: '🔄' },
];
const DONKEY = { key: 'donkey', label: 'Donkey (Overflow)', emojiKey: 'DONKEY_EMOJI', defaultEmoji: '🐴' };

// Offered in the emoji drop-downs; any other Unicode or custom emoji can be typed or pasted.
const BUILTIN_EMOJIS = [
  '⚔️', '🛡️', '👑', '🎵', '🔄', '🐴', '🏹', '🗡️', '🪓', '🔥', '💥', '⚡',
  '❄️', '🎯', '🐉', '🧙', '🩹', '❤️', '💙', '💚', '💛', '💜', '⭐', '🚩',
];

const TITLE_MAX = 256;        // Discord embed title limit
const DESCRIPTION_MAX = 4000; // embed description limit is 4096
const POOL_MAX_LIMIT = 100;

const DEFAULTS = {
  AUTO_EVENT_SCHEDULE: '21:30',
  AUTO_EVENT_TITLE: 'Guild Raid Signup',
  AUTO_EVENT_DESCRIPTION: "React to join your pool for today's raid",
  DONKEY_EMOJI: DONKEY.defaultEmoji,
};

const LEGACY_ROLE_DEFAULTS = {};
for (const p of POOLS) {
  LEGACY_ROLE_DEFAULTS[p.maxKey] = p.defaultMax;
  LEGACY_ROLE_DEFAULTS[p.emojiKey] = p.defaultEmoji;
}

const KEYS = Object.keys(DEFAULTS);
const LEGACY_ROLE_KEYS = Object.keys(LEGACY_ROLE_DEFAULTS);
const ALL_KEYS = [...KEYS, ...LEGACY_ROLE_KEYS];
const EMOJI_KEYS = [...POOLS.map((p) => p.emojiKey), DONKEY.emojiKey];
const MAX_KEYS = POOLS.map((p) => p.maxKey);

function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function validateMax(value) {
  const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > POOL_MAX_LIMIT) {
    return { error: `Enter a whole number from 1 to ${POOL_MAX_LIMIT}.` };
  }
  return { value: n };
}

function validateEmoji(value) {
  const parsed = parseEmoji(value);
  if (!parsed) return { error: 'Enter a single Unicode emoji or a Discord custom emoji like <:name:123456789012345678>.' };
  return { value: parsed.value };
}

// Validates one key (current or legacy role key). `value` may come from the UI
// (typed) or from env (string). Returns { value } or { error }.
function validateField(key, value) {
  if (key === 'AUTO_EVENT_SCHEDULE') {
    const t = normalizeTime(value);
    return t ? { value: t } : { error: 'Use 24-hour HH:MM, for example 21:30.' };
  }
  if (key === 'AUTO_EVENT_TITLE') {
    if (typeof value !== 'string' || !value.trim()) return { error: 'Title is required.' };
    if (value.trim().length > TITLE_MAX) return { error: `Title must be at most ${TITLE_MAX} characters.` };
    return { value: value.trim() };
  }
  if (key === 'AUTO_EVENT_DESCRIPTION') {
    if (typeof value !== 'string') return { error: 'Description must be text.' };
    const v = value.replace(/\r\n/g, '\n').trim();
    if (v.length > DESCRIPTION_MAX) return { error: `Description must be at most ${DESCRIPTION_MAX} characters.` };
    return { value: v };
  }
  if (MAX_KEYS.includes(key)) return validateMax(value);
  if (EMOJI_KEYS.includes(key)) return validateEmoji(value);
  return { error: 'Unknown setting.' };
}

// Validates a complete settings object from the UI.
// Returns { ok:true, value } or { ok:false, errors: { KEY: message } }.
function validateSettings(input) {
  const errors = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { _form: 'Settings must be an object.' } };
  }
  for (const key of Object.keys(input)) {
    if (!KEYS.includes(key)) errors[key] = 'Unknown setting.';
  }
  const value = {};
  for (const key of KEYS) {
    if (!(key in input)) {
      errors[key] = 'This setting is required.';
      continue;
    }
    const r = validateField(key, input[key]);
    if (r.error) errors[key] = r.error;
    else value[key] = r.value;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

// Precedence, highest first:
//   1. saved     — values the user saved in the desktop UI (settings.json)
//   2. env       — real environment, then baked build values, then .env, then
//                  legacy config.json (see config loader)
//   3. defaults
// Invalid values at any level fall through to the next one with a warning.
function resolveKeys(keys, defaults, { saved = {}, env = {} }) {
  const values = {};
  const sources = {};
  const warnings = [];
  for (const key of keys) {
    if (saved[key] !== undefined) {
      const r = validateField(key, saved[key]);
      if (!r.error) { values[key] = r.value; sources[key] = 'saved'; continue; }
      warnings.push(`Saved ${key} is invalid (${r.error}) and was ignored.`);
    }
    if (env[key] !== undefined && env[key] !== '') {
      const r = validateField(key, env[key]);
      if (!r.error) { values[key] = r.value; sources[key] = 'environment'; continue; }
      warnings.push(`${key} from the build/environment is invalid (${r.error}); using the default.`);
    }
    values[key] = defaults[key];
    sources[key] = 'default';
  }
  return { values, sources, warnings };
}

function resolveSettings({ saved = {}, env = {} } = {}) {
  return resolveKeys(KEYS, DEFAULTS, { saved, env });
}

// The five built-in roles with max/emoji taken from saved (older versions),
// env/baked, or defaults. Seeds schedule.json's role list on first run.
function resolveLegacyRoles({ saved = {}, env = {} } = {}) {
  const { values } = resolveKeys(LEGACY_ROLE_KEYS, LEGACY_ROLE_DEFAULTS, { saved, env });
  return POOLS.map((p) => ({ key: p.key, label: p.label, emoji: values[p.emojiKey], max: values[p.maxKey] }));
}

module.exports = {
  POOLS, DONKEY, BUILTIN_EMOJIS, DEFAULTS, KEYS, ALL_KEYS, LEGACY_ROLE_KEYS, LEGACY_ROLE_DEFAULTS,
  EMOJI_KEYS, MAX_KEYS, POOL_MAX_LIMIT,
  normalizeTime, validateField, validateMax, validateEmoji, validateSettings, resolveSettings, resolveLegacyRoles,
};
