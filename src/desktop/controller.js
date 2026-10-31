// Connects the desktop UI to the backend. Every UI request is already
// shape-validated by ipc.parseUiMessage; this layer applies business rules and
// always answers requests with { ok, ... } so the UI can show feedback.
const { buildStatusView } = require('./statusView');
const { BUILTIN_EMOJIS, POOL_MAX_LIMIT, validateSettings } = require('../settings/schema');
const { MAX_ROLES, validateRoles } = require('../settings/roles');
const { redact } = require('../utils/logger');

const DAY_LABELS = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

class DesktopController {
  // schedule: scheduler/scheduleConfig (roles + weekdays). edition: 'full' | 'lite'.
  constructor({ ui, hosting, store, schedule, monitor, autostart, connection, checkEmojis, applyChange, requestExit, autoEvent = null, edition = 'full', now = Date.now }) {
    Object.assign(this, { ui, hosting, store, schedule, monitor, autostart, connection, checkEmojis, applyChange, requestExit, autoEvent, edition, now });
    this._savingSchedule = false;
    this._onUiMessage = (msg) => this.handle(msg).catch((err) => console.error('[UI] Handler error:', err));
    ui.on('message', this._onUiMessage);
    hosting.on('status', () => this.pushStatus());
    monitor.on('update', () => this.pushStatus());
    if (autoEvent) autoEvent.status.on('change', () => this.pushStatus());
    // Changed by /raid-schedule or a leader's sync: show it in the window.
    // Our own save answers with the new values instead.
    schedule.on('change', () => { if (!this._savingSchedule) this.pushSettings(); });
  }

  // Sent once per UI process start.
  initPayload({ startMinimized, notice, logPath }) {
    return {
      nodePid: process.pid,
      logPath,
      startMinimized: !!startMinimized,
      notice: notice || null,
      edition: this.edition,
      builtinEmojis: BUILTIN_EMOJIS,
      maxLimit: POOL_MAX_LIMIT,
      maxRoles: MAX_ROLES,
    };
  }

  statusView() {
    return buildStatusView({
      hosting: this.hosting.status,
      hostingEnabled: this.store.isHostingEnabled(),
      connection: this.connection,
      monitor: this.monitor.snapshot,
      autoEvent: this.autoEvent ? this.autoEvent.getStatus() : null,
      now: this.now(),
    });
  }

  pushStatus() {
    this.ui.send({ type: 'status', status: this.statusView() });
  }

  // Everything the Automatic event section edits.
  settingsView() {
    const view = this.store.getView();
    return { values: view.values, roles: this.schedule.getRoles(), days: this.schedule.getEnabledDays(), warnings: view.warnings };
  }

  pushSettings() {
    if (this.edition === 'lite') return;
    this.ui.send({ type: 'settings', ...this.settingsView() });
  }

  respond(id, body) {
    this.ui.send({ type: 'response', id, ...body });
  }

  async handle(msg) {
    switch (msg.type) {
      case 'ready':
        this.pushSettings();
        this.pushStatus();
        return;
      case 'getSettings':
        return this.respond(msg.id, { ok: true, ...this.settingsView() });
      case 'saveSettings':
        return this.respond(msg.id, await this.saveSettings(msg));
      case 'setHosting':
        return this.respond(msg.id, await this.setHosting(msg.enabled));
      case 'createEventNow':
        return this.respond(msg.id, await this.createEventNow());
      case 'refreshNodes':
        await this.monitor.refresh();
        return this.respond(msg.id, { ok: true });
      case 'visibility':
        this.monitor.setVisible(msg.visible);
        return;
      case 'log':
        console[msg.level === 'info' ? 'log' : msg.level]('[UI]', msg.message);
        return;
      case 'exit':
        return this.requestExit('tray', { expectUiExit: false });
      case 'endSession':
        return this.requestExit('endSession', { expectUiExit: true });
    }
  }

  // { settings, roles, days } from the Automatic event section.
  async saveSettings({ settings, roles, days }) {
    if (this.edition === 'lite') return { ok: false, error: 'Settings can only be changed in the full version of the app.' };

    const v = validateSettings(settings);
    const r = validateRoles(roles, { donkeyEmoji: v.ok ? v.value.DONKEY_EMOJI : settings.DONKEY_EMOJI });
    if (!v.ok || !r.ok) {
      const fieldErrors = { ...(v.ok ? {} : v.errors), ...(r.ok ? {} : r.errors) };
      return { ok: false, fieldErrors, error: fieldErrors._form || fieldErrors.roles || '' };
    }

    const emojis = [
      ...r.value.map((role, i) => ({ key: `roles.${i}.emoji`, emoji: role.emoji })),
      { key: 'DONKEY_EMOJI', emoji: v.value.DONKEY_EMOJI },
    ];
    const check = await this.checkEmojis(emojis);
    if (Object.keys(check.errors).length) return { ok: false, fieldErrors: check.errors, error: '' };

    const saved = this.store.save(v.value);
    if (!saved.ok) return { ok: false, fieldErrors: saved.errors || {}, error: saved.error || '' };

    let effects;
    this._savingSchedule = true;
    try {
      effects = this.applyChange({ prev: saved.prev, next: saved.value, roles: r.value, days });
    } finally {
      this._savingSchedule = false;
    }
    let message = 'Settings saved. Future events will use them.';
    if (effects.changedDays.length) {
      message += ` Updated schedule for: ${effects.changedDays.map((d) => DAY_LABELS[d]).join(', ')}.`;
    }
    const warnings = [...check.warnings, ...effects.warnings];
    if (this.hosting.status.role === 'standby') {
      warnings.push("This PC is a standby: the leader PC's schedule replaces these roles and days at its next sync. Make schedule changes on the leader PC.");
    }
    const view = this.settingsView();
    return { ok: true, values: view.values, roles: view.roles, days: view.days, message, warnings };
  }

  // "Create event now": posts a card right away with the saved settings. Only
  // the leader runs the bot that posts it and tracks its reactions.
  async createEventNow() {
    if (this.edition === 'lite') return { ok: false, error: 'Only the full version of the app can create events.' };
    if (!this.autoEvent || this.hosting.status.role !== 'leader') {
      return { ok: false, error: 'Only the leader PC can post events. Turn hosting on here, or use the leader PC.' };
    }
    try {
      const { title } = await this.autoEvent.createNow();
      return { ok: true, message: `Event "${title}" posted in the event channel.` };
    } catch (err) {
      return { ok: false, error: `The event was not posted: ${redact(err.message)}` };
    }
  }

  async setHosting(enabled) {
    const warnings = [];
    if (enabled) {
      if (!this.connection.ok) {
        return { ok: false, error: `Hosting needs a Discord connection, but this build is missing ${this.connection.missing.join(', ')}.` };
      }
      try {
        this.store.setHostingEnabled(true);
      } catch (err) {
        return { ok: false, error: `Could not save the hosting choice: ${redact(err.message)}` };
      }
      const a = this.autostart.setAutoStart(true);
      if (!a.ok) warnings.push(`Windows sign-in startup could not be enabled (${a.error}).`);
      this.pushStatus();
      // Starting runs in the background; progress arrives as status updates.
      this.hosting.start().catch((err) => console.error('[Hosting] start error:', err.message));
      return { ok: true, message: 'Hosting turned ON. This PC will also start hosting when you sign in to Windows.', warnings };
    }

    try {
      this.store.setHostingEnabled(false);
    } catch (err) {
      return { ok: false, error: `Could not save the hosting choice: ${redact(err.message)}` };
    }
    const a = this.autostart.setAutoStart(false);
    if (!a.ok) warnings.push(`Windows sign-in startup could not be disabled (${a.error}).`);
    this.pushStatus();
    await this.hosting.stop();
    return { ok: true, message: 'Hosting turned OFF. The app will no longer start when you sign in.', warnings };
  }
}

module.exports = { DesktopController };
