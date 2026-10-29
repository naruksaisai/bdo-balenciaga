const { EventEmitter } = require('events');
const path = require('path');
const { DATA_DIR } = require('../utils/dataDir');
const { writeJsonAtomic, readJsonFile } = require('../utils/safeWrite');
const { normalizeTime } = require('../settings/schema');

const DEFAULT_FILE = path.join(DATA_DIR, 'schedule.json');
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const POOL_KEYS = ['mainball', 'def-team', 'commander', 'shai', 'flex'];

function isPositiveInt(v) {
  return Number.isInteger(v) && v >= 1;
}

// Fills in anything missing or invalid from `defaults`, field by field, so one
// bad value never costs the user the rest of their per-day customizations.
function normalizeSchedule(raw, defaults) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const day of DAYS) {
    const d = src[day] && typeof src[day] === 'object' ? src[day] : {};
    const def = defaults[day];
    const pools = {};
    for (const p of POOL_KEYS) {
      pools[p] = isPositiveInt(d.pools && d.pools[p]) ? d.pools[p] : def.pools[p];
    }
    out[day] = {
      enabled: typeof d.enabled === 'boolean' ? d.enabled : def.enabled,
      time: normalizeTime(d.time) || def.time,
      pools,
    };
  }
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
    // Lazy-require config so env vars are guaranteed to be loaded first
    const defaults = this._buildDefaults(require('../config'));
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
    this._schedule = defaults;
    this._trySave();
    console.log('[ScheduleConfig] Created schedule.json with defaults');
  }

  _buildDefaults(config) {
    const defaultPools = { ...config.autoEvent.poolLimits };
    const defaultTime = config.autoEvent.schedule || '20:00';
    const defaultEnabled = config.autoEvent.enabled;
    const schedule = {};
    for (const day of DAYS) {
      schedule[day] = {
        enabled: defaultEnabled,
        time: defaultTime,
        pools: { ...defaultPools },
      };
    }
    return schedule;
  }

  // Returns a deep copy of the full schedule, or a single day's config
  get(day) {
    if (!this._schedule) return day ? null : {};
    if (day) return this._schedule[day] ? JSON.parse(JSON.stringify(this._schedule[day])) : null;
    return JSON.parse(JSON.stringify(this._schedule));
  }

  // Patch a single day. patch may contain: time, enabled, pools (partial)
  update(day, patch) {
    if (!this._schedule[day]) throw new Error(`Unknown day: ${day}`);
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
        if (!POOL_KEYS.includes(k)) throw new Error(`Unknown pool: ${k}`);
        if (!isPositiveInt(v)) throw new Error(`Pool capacity must be a positive integer`);
        current.pools[k] = v;
      }
    }

    this._commit(next);
  }

  // Replace the entire schedule (used by HA standby sync). Only emits if changed.
  applyFull(newSchedule) {
    const next = normalizeSchedule(newSchedule, this._schedule || this._buildDefaults(require('../config')));
    if (JSON.stringify(this._schedule) === JSON.stringify(next)) return;
    this._commit(next);
  }

  // Called when the user edits the default time / pool limits in the desktop UI.
  // Only days still using the previous default move to the new one; days that
  // were customized (e.g. with /raid-schedule) are preserved.
  // prev/next: { time, pools: { mainball: n, ... } }. Returns the changed days.
  applyDefaultsChange(prev, next) {
    if (!this._schedule) return [];
    const updated = this.get();
    const changed = [];
    for (const day of DAYS) {
      const d = updated[day];
      let dayChanged = false;
      if (prev.time !== next.time && d.time === prev.time) {
        d.time = next.time;
        dayChanged = true;
      }
      for (const p of POOL_KEYS) {
        if (prev.pools[p] !== next.pools[p] && d.pools[p] === prev.pools[p]) {
          d.pools[p] = next.pools[p];
          dayChanged = true;
        }
      }
      if (dayChanged) changed.push(day);
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
