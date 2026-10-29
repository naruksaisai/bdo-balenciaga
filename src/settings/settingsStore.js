const path = require('path');
const { DATA_DIR } = require('../utils/dataDir');
const { writeJsonAtomic, readJsonFile } = require('../utils/safeWrite');
const schema = require('./schema');

const SETTINGS_VERSION = 1;

// settings.json (per-user data dir):
//   { version, hostingEnabled, settings: { AUTO_EVENT_TITLE: ..., ... } }
// `settings` holds only what the user saved; effective values are resolved on
// read against env/baked/default values (see schema.resolveSettings).
class SettingsStore {
  constructor(file) {
    this.file = file;
    this._doc = null;
    this.loadWarnings = [];
    this.firstLaunch = false;
  }

  // legacySettings: editable keys recovered from a legacy config.json; adopted
  // only on first launch (no settings.json yet).
  load({ legacySettings = {} } = {}) {
    this.loadWarnings = [];
    const r = readJsonFile(this.file);
    if (r.exists && r.value && typeof r.value === 'object') {
      const saved = r.value.settings && typeof r.value.settings === 'object' ? r.value.settings : {};
      this._doc = {
        version: SETTINGS_VERSION,
        hostingEnabled: r.value.hostingEnabled === true,
        settings: this._keepValid(saved, 'Saved'),
      };
      return this;
    }
    if (r.exists) {
      this.loadWarnings.push(
        r.movedTo
          ? `settings.json was unreadable and was moved to ${path.basename(r.movedTo)}; defaults restored.`
          : `settings.json could not be read (${r.error && r.error.message}); using defaults.`
      );
    }
    this.firstLaunch = !r.exists;
    this._doc = {
      version: SETTINGS_VERSION,
      hostingEnabled: false, // hosting defaults to OFF on first launch
      settings: this.firstLaunch ? this._keepValid(legacySettings, 'Legacy config.json') : {},
    };
    try {
      this._write(this._doc);
    } catch (err) {
      this.loadWarnings.push(`Could not create settings file: ${err.message}`);
    }
    return this;
  }

  _keepValid(obj, label) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!schema.KEYS.includes(k)) continue;
      const r = schema.validateField(k, v);
      if (r.error) this.loadWarnings.push(`${label} ${k} is invalid and was ignored: ${r.error}`);
      else out[k] = r.value;
    }
    return out;
  }

  _ensureLoaded() {
    if (!this._doc) this.load();
  }

  _write(doc) {
    writeJsonAtomic(this.file, doc);
  }

  getView() {
    this._ensureLoaded();
    const r = schema.resolveSettings({ saved: this._doc.settings, env: process.env });
    return { ...r, warnings: [...this.loadWarnings, ...r.warnings] };
  }

  getEffective() {
    return this.getView().values;
  }

  // Validates, persists, then commits in memory — a failed write leaves the
  // running configuration untouched. Returns prev/next for side effects.
  save(input) {
    this._ensureLoaded();
    const v = schema.validateSettings(input);
    if (!v.ok) return { ok: false, errors: v.errors };
    const prev = this.getEffective();
    const doc = { ...this._doc, settings: v.value };
    try {
      this._write(doc);
    } catch (err) {
      return { ok: false, error: `Could not save settings: ${err.message}` };
    }
    this._doc = doc;
    return { ok: true, value: this.getEffective(), prev };
  }

  isHostingEnabled() {
    this._ensureLoaded();
    return this._doc.hostingEnabled;
  }

  setHostingEnabled(enabled) {
    this._ensureLoaded();
    const doc = { ...this._doc, hostingEnabled: !!enabled };
    this._write(doc); // throws on failure; caller reports it
    this._doc = doc;
  }
}

const store = new SettingsStore(path.join(DATA_DIR, 'settings.json'));
module.exports = store;
module.exports.SettingsStore = SettingsStore;
