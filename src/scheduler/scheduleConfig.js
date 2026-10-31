const { EventEmitter } = require('events');
const path = require('path');
const { DATA_DIR } = require('../utils/dataDir');
const { writeJsonAtomic, readJsonFile } = require('../utils/safeWrite');
const { normalizeTime } = require('../settings/schema');
const { normalizeRoles } = require('../settings/roles');

const DEFAULT_FILE = path.join(DATA_DIR, 'schedule.json');
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// schedule.json (synced to standbys by the HA leader):
//   { monday: { enabled, time, pools: { <roleKey>: max } }, …, roles: [{ key, label, emoji, max }] }
// Older versions ignore `roles` (they only read the day keys).

function isPositiveInt(v) {
  return Number.isInteger(v) && v >= 1;
}

// Fills in anything missing or invalid from `defaults`, field by field, so one
// bad value never costs the user the rest of their per-day customizations.
// defaults: { roles, days: { <day>: { enabled, time } } }
function normalizeSchedule(raw, defaults) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  const roles = normalizeRoles(src.roles, defaults.roles);
  for (const day of DAYS) {
    const d = src[day] && typeof src[day] === 'object' ? src[day] : {};
    const def = defaults.days[day];
    const pools = {};
    for (const r of roles) {
      pools[r.key] = isPositiveInt(d.pools && d.pools[r.key]) ? d.pools[r.key] : r.max;
    }
    out[day] = {
      enabled: typeof d.enabled === 'boolean' ? d.enabled : def.enabled,
      time: normalizeTime(d.time) || def.time,
      pools,
    };
  }
  out.roles = roles;
  return out;
}

class ScheduleConfig extends EventEmitter {
  constructor() {
    super();
    this._schedule = null;
    this._file = DEFAULT_FILE;
  }

  init(file = DEFAULT_FILE) {
    this._file = file;
    const defaults = this._buildDefaults();
    const r = readJsonFile(this._file);
    if (r.exists && r.value) {
      this._schedule = normalizeSchedule(r.value, defaults);
      if (JSON.stringify(this._schedule) !== JSON.stringify(r.value)) this._trySave();
      console.log('[ScheduleConfig] Loaded schedule.json');
      return;
    }
    if (r.movedTo) {
      console.warn(`[ScheduleConfig] schedule.json was unreadable; kept a copy at ${r.movedTo}`);
    }
    this._schedule = normalizeSchedule({}, defaults);
    this._trySave();
    console.log('[ScheduleConfig] Created schedule.json with defaults');
  }

  // Lazy-require config/settings so env vars are guaranteed to be loaded first.
  // The built-in roles come from the values older versions kept per PC.
  _buildDefaults() {
    const config = require('../config');
    const days = {};
    for (const day of DAYS) {
      days[day] = { enabled: config.autoEvent.enabled, time: config.autoEvent.schedule || '20:00' };
    }
    return { roles: require('../settings/settingsStore').getLegacyRoles(), days };
  }

  // The current schedule as defaults, so a repair never resets other fields.
  _currentDefaults() {
    if (!this._schedule) return this._buildDefaults();
    const days = {};
    for (const day of DAYS) days[day] = { enabled: this._schedule[day].enabled, time: this._schedule[day].time };
    return { roles: this._schedule.roles, days };
  }

  // Returns a deep copy of the full schedule, or a single day's config
  get(day) {
    if (!this._schedule) return day ? null : {};
    if (day) return DAYS.includes(day) ? JSON.parse(JSON.stringify(this._schedule[day])) : null;
    return JSON.parse(JSON.stringify(this._schedule));
  }

  getRoles() {
    return this._schedule ? JSON.parse(JSON.stringify(this._schedule.roles)) : [];
  }

  // { monday: true, … } — which weekdays get an automatic event.
  getEnabledDays() {
    const out = {};
    for (const day of DAYS) out[day] = !!(this._schedule && this._schedule[day].enabled);
    return out;
  }

  // Patch a single day. patch may contain: time, enabled, pools (partial)
  update(day, patch) {
    if (!DAYS.includes(day)) throw new Error(`Unknown day: ${day}`);
    const next = this.get();
    const current = next[day];

    if (patch.time !== undefined) {
      const time = normalizeTime(patch.time);
      if (!time) throw new Error(`Invalid time: "${patch.time}" — use HH:MM (24h)`);
      current.time = time;
    }
    if (patch.enabled !== undefined) current.enabled = patch.enabled;
    if (patch.pools) {
      for (const [k, v] of Object.entries(patch.pools)) {
        if (!next.roles.some((r) => r.key === k)) throw new Error(`Unknown role: ${k}`);
        if (!isPositiveInt(v)) throw new Error(`Pool capacity must be a positive integer`);
        current.pools[k] = v;
      }
    }

    this._commit(next);
  }

  // Replace the entire schedule (used by HA standby sync). Only emits if changed.
  // A broadcast from an older leader has no `roles`; the local list is kept.
  applyFull(newSchedule) {
    const next = normalizeSchedule(newSchedule, this._currentDefaults());
    if (JSON.stringify(this._schedule) === JSON.stringify(next)) return;
    this._commit(next);
  }

  // Saves the role list and weekday selection from the desktop UI. Per-day
  // limits: a new role starts at its max on every day, a removed role is
  // dropped, and a changed max moves only the days still on the old max (days
  // customized with /raid-schedule keep their value). roles must already be
  // validated (settings/roles.validateRoles). Returns the days whose limits changed.
  setRolesAndDays(roles, enabledByDay) {
    const next = this.get();
    const prevMax = new Map(next.roles.map((r) => [r.key, r.max]));
    const changed = [];
    for (const day of DAYS) {
      const d = next[day];
      if (enabledByDay && typeof enabledByDay[day] === 'boolean') d.enabled = enabledByDay[day];
      const pools = {};
      for (const r of roles) {
        const old = d.pools[r.key];
        pools[r.key] = !prevMax.has(r.key) || !isPositiveInt(old) || old === prevMax.get(r.key) ? r.max : old;
      }
      if (JSON.stringify(pools) !== JSON.stringify(d.pools)) changed.push(day);
      d.pools = pools;
    }
    next.roles = roles.map((r) => ({ key: r.key, label: r.label, emoji: r.emoji, max: r.max }));
    if (JSON.stringify(next) !== JSON.stringify(this._schedule)) this._commit(next);
    return changed;
  }

  // Called when the user edits the default time in the desktop UI. Only days
  // still using the previous default move to the new one; days that were
  // customized (e.g. with /raid-schedule) are preserved. Returns the changed days.
  applyDefaultsChange(prev, next) {
    if (!this._schedule || prev.time === next.time) return [];
    const updated = this.get();
    const changed = [];
    for (const day of DAYS) {
      if (updated[day].time === prev.time) {
        updated[day].time = next.time;
        changed.push(day);
      }
    }
    if (changed.length) this._commit(updated);
    return changed;
  }

  // Persist first, then swap in memory: a failed write throws and leaves the
  // running schedule unchanged.
  _commit(next) {
    writeJsonAtomic(this._file, next);
    this._schedule = next;
    this.emit('change');
  }

  _trySave() {
    try {
      writeJsonAtomic(this._file, this._schedule);
    } catch (err) {
      console.warn('[ScheduleConfig] Could not write schedule.json:', err.message);
    }
  }
}

module.exports = new ScheduleConfig();
module.exports.normalizeSchedule = normalizeSchedule;
module.exports.DAYS = DAYS;
