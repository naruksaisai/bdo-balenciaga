// Node ↔ desktop UI protocol: one JSON object per line over the UI process's
// stdin/stdout. Everything arriving from the UI is validated against this
// whitelist before the controller sees it; anything else is dropped.
const { redact } = require('../utils/logger');
const { KEYS } = require('../settings/schema');
const { MAX_ROLES } = require('../settings/roles');

const MAX_LINE_BYTES = 64 * 1024;
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const isBool = (v) => typeof v === 'boolean';
const isId = (v) => Number.isInteger(v) && v > 0 && v < 2 ** 31;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isShortString = (max) => (v) => typeof v === 'string' && v.length <= max;
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// type → { request: needs a numeric id and gets a response, fields: validators }
const UI_MESSAGES = {
  ready:        { request: false, fields: {} },
  getSettings:  { request: true,  fields: {} },
  saveSettings: { request: true,  fields: { settings: isSettingsPayload, roles: isRolesPayload, days: isDaysPayload } },
  setHosting:   { request: true,  fields: { enabled: isBool } },
  refreshNodes: { request: true,  fields: {} },
  createEventNow: { request: true, fields: {} },
  visibility:   { request: false, fields: { visible: isBool } },
  exit:         { request: false, fields: {} },
  endSession:   { request: false, fields: {} },
  log:          { request: false, fields: { level: (v) => ['info', 'warn', 'error'].includes(v), message: (v) => typeof v === 'string' && v.length <= 2000 } },
};

// Shape checks only (known keys, primitive values); semantic validation happens
// in settings/schema and settings/roles so the UI gets per-field error messages.
function isSettingsPayload(v) {
  if (!isObject(v)) return false;
  return Object.entries(v).every(([k, val]) =>
    KEYS.includes(k) && (typeof val === 'string' ? val.length <= 5000 : isNumber(val)));
}

const ROLE_FIELDS = { key: isShortString(40), label: isShortString(100), emoji: isShortString(100), max: isNumber };
function isRolesPayload(v) {
  return Array.isArray(v) && v.length <= MAX_ROLES && v.every((r) =>
    isObject(r) &&
    Object.keys(r).length === Object.keys(ROLE_FIELDS).length &&
    Object.entries(ROLE_FIELDS).every(([k, check]) => Object.prototype.hasOwnProperty.call(r, k) && check(r[k])));
}

function isDaysPayload(v) {
  return isObject(v) && Object.keys(v).length === DAYS.length && DAYS.every((d) => isBool(v[d]));
}

// Returns { ok:true, message } or { ok:false, error, id? } (id when the bad
// message was a request we can still answer).
function parseUiMessage(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    return { ok: false, error: 'Message too large' };
  }
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { ok: false, error: 'Malformed JSON' };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: 'Not an object' };

  const spec = Object.prototype.hasOwnProperty.call(UI_MESSAGES, msg.type) ? UI_MESSAGES[msg.type] : null;
  const id = isId(msg.id) ? msg.id : undefined;
  if (!spec) return { ok: false, error: `Unknown message type`, id };
  if (spec.request && id === undefined) return { ok: false, error: 'Missing request id' };

  const allowed = new Set(['type', ...(spec.request ? ['id'] : []), ...Object.keys(spec.fields)]);
  for (const k of Object.keys(msg)) {
    if (!allowed.has(k)) return { ok: false, error: `Unexpected field "${k}"`, id };
  }
  for (const [k, check] of Object.entries(spec.fields)) {
    if (!check(msg[k])) return { ok: false, error: `Invalid field "${k}"`, id };
  }
  return { ok: true, message: msg };
}

// Serializes a Node → UI message: token redacted, and every non-ASCII char
// escaped as \uXXXX so the wire format is pure ASCII (immune to code pages).
function serializeForUi(msg) {
  const json = redact(JSON.stringify(msg));
  return json.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

module.exports = { parseUiMessage, serializeForUi, UI_MESSAGES, MAX_LINE_BYTES };
