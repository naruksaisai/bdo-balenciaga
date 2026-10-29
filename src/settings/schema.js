// User-editable settings: keys, defaults, validation and precedence. Pure — no
// file or Discord access — so it can be unit tested directly.
const { parseEmoji } = require('../utils/emoji');

const POOLS = [
  { key: 'mainball',  label: 'Mainball',          maxKey: 'AUTO_EVENT_MAINBALL_MAX',  emojiKey: 'MAINBALL_EMOJI',  defaultMax: 20, defaultEmoji: '⚔️' },
  { key: 'def-team',  label: 'Def Team',          maxKey: 'AUTO_EVENT_DEF_TEAM_MAX',  emojiKey: 'DEF_TEAM_EMOJI',  defaultMax: 10, defaultEmoji: '🛡️' },
  { key: 'commander', label: 'Commander',         maxKey: 'AUTO_EVENT_COMMANDER_MAX', emojiKey: 'COMMANDER_EMOJI', defaultMax: 2,  defaultEmoji: '👑' },
  { key: 'shai',      label: 'Shai',              maxKey: 'AUTO_EVENT_SHAI_MAX',      emojiKey: 'SHAI_EMOJI',      defaultMax: 3,  defaultEmoji: '🎵' },
  { key: 'flex',      label: 'Flex',              maxKey: 'AUTO_EVENT_FLEX_MAX',      emojiKey: 'FLEX_EMOJI',      defaultMax: 5,  defaultEmoji: '🔄' },
  { key: 'donkey',    label: 'Donkey (Overflow)', maxKey: null,                       emojiKey: 'DONKEY_EMOJI',    defaultMax: null, defaultEmoji: '🐴' },
];

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
};
for (const p of POOLS) {
  if (p.maxKey) DEFAULTS[p.maxKey] = p.defaultMax;
  DEFAULTS[p.emojiKey] = p.defaultEmoji;
}

const KEYS = Object.keys(DEFAULTS);
const EMOJI_KEYS = POOLS.map((p) => p.emojiKey);
const MAX_KEYS = POOLS.filter((p) => p.maxKey).map((p) => p.maxKey);

function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// Validates one key. `value` may come from the UI (typed) or from env (string).
// Returns { value } or { error }.
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
  if (MAX_KEYS.includes(key)) {
    const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(n) || n < 1 || n > POOL_MAX_LIMIT) {
      return { error: `Enter a whole number from 1 to ${POOL_MAX_LIMIT}.` };
    }
    return { value: n };
  }
  if (EMOJI_KEYS.includes(key)) {
    const parsed = parseEmoji(value);
    if (!parsed) return { error: 'Enter a single Unicode emoji or a Discord custom emoji like <:name:123456789012345678>.' };
    return { value: parsed.value };
  }
  return { error: 'Unknown setting.' };
}

function poolLabelForEmojiKey(key) {
  return POOLS.find((p) => p.emojiKey === key).label;
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

  // Two pools sharing an emoji would make reactions ambiguous.
  const seen = new Map();
  for (const key of EMOJI_KEYS) {
    if (!(key in value)) continue;
    const k = parseEmoji(value[key]).key;
    if (seen.has(k)) errors[key] = `Same emoji as ${poolLabelForEmojiKey(seen.get(k))}.`;
    else seen.set(k, key);
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

// Precedence, highest first:
//   1. saved     — values the user saved in the desktop UI (settings.json)
//   2. env       — real environment, then baked build values, then .env, then
//                  legacy config.json (see config loader)
//   3. DEFAULTS
// Invalid values at any level fall through to the next one with a warning.
function resolveSettings({ saved = {}, env = {} } = {}) {
  const values = {};
  const sources = {};
  const warnings = [];
  for (const key of KEYS) {
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
    values[key] = DEFAULTS[key];
    sources[key] = 'default';
  }
  // Duplicate emojis across levels (e.g. one saved, one from env) — fall back
  // to defaults for the later duplicates so reactions stay unambiguous.
  const seen = new Set();
  for (const key of EMOJI_KEYS) {
    const k = parseEmoji(values[key]).key;
    if (seen.has(k)) {
      warnings.push(`${key} duplicates another pool's emoji; using the default.`);
      values[key] = DEFAULTS[key];
      sources[key] = 'default';
    }
    seen.add(parseEmoji(values[key]).key);
  }
  return { values, sources, warnings };
}

// Effective settings → the shapes the bot code uses.
function toEmojiMap(values) {
  const out = {};
  for (const p of POOLS) out[p.key] = values[p.emojiKey];
  return out;
}

function toPoolLimits(values) {
  const out = {};
  for (const p of POOLS) if (p.maxKey) out[p.key] = values[p.maxKey];
  return out;
}

module.exports = {
  POOLS, BUILTIN_EMOJIS, DEFAULTS, KEYS, EMOJI_KEYS, MAX_KEYS, POOL_MAX_LIMIT,
  normalizeTime, validateField, validateSettings, resolveSettings, toEmojiMap, toPoolLimits,
};
