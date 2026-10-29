// Connects the desktop UI to the backend. Every UI request is already
// shape-validated by ipc.parseUiMessage; this layer applies business rules and
// always answers requests with { ok, ... } so the UI can show feedback.
const { buildStatusView } = require('./statusView');
const { POOLS, BUILTIN_EMOJIS, POOL_MAX_LIMIT, validateSettings } = require('../settings/schema');
const { redact } = require('../utils/logger');

const DAY_LABELS = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

class DesktopController {
  constructor({ ui, hosting, store, monitor, autostart, connection, checkEmojis, applyChange, requestExit, now = Date.now }) {
    Object.assign(this, { ui, hosting, store, monitor, autostart, connection, checkEmojis, applyChange, requestExit, now });
    this._onUiMessage = (msg) => this.handle(msg).catch((err) => console.error('[UI] Handler error:', err));
    ui.on('message', this._onUiMessage);
    hosting.on('status', () => this.pushStatus());
    monitor.on('update', () => this.pushStatus());
  }

  // Sent once per UI process start.
  initPayload({ startMinimized, notice, logPath }) {
    return {
      nodePid: process.pid,
      logPath,
      startMinimized: !!startMinimized,
      notice: notice || null,
      pools: POOLS.map((p) => ({ key: p.key, label: p.label, maxKey: p.maxKey || '', emojiKey: p.emojiKey })),
      builtinEmojis: BUILTIN_EMOJIS,
      maxLimit: POOL_MAX_LIMIT,
    };
  }

  statusView() {
    return buildStatusView({
      hosting: this.hosting.status,
      hostingEnabled: this.store.isHostingEnabled(),
      connection: this.connection,
      monitor: this.monitor.snapshot,
      now: this.now(),
    });
  }

  pushStatus() {
    this.ui.send({ type: 'status', status: this.statusView() });
  }

  pushSettings() {
    const view = this.store.getView();
    this.ui.send({ type: 'settings', values: view.values, warnings: view.warnings });
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
      case 'getSettings': {
        const view = this.store.getView();
        return this.respond(msg.id, { ok: true, values: view.values, warnings: view.warnings });
      }
      case 'saveSettings':
        return this.respond(msg.id, await this.saveSettings(msg.settings));
      case 'setHosting':
        return this.respond(msg.id, await this.setHosting(msg.enabled));
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

  async saveSettings(input) {
    const v = validateSettings(input);
    if (!v.ok) return { ok: false, fieldErrors: v.errors, error: v.errors._form || '' };

    const check = await this.checkEmojis(v.value);
    if (Object.keys(check.errors).length) return { ok: false, fieldErrors: check.errors, error: '' };

    const saved = this.store.save(v.value);
    if (!saved.ok) return { ok: false, fieldErrors: saved.errors || {}, error: saved.error || '' };

    const effects = this.applyChange(saved.prev, saved.value);
    let message = 'Settings saved. Future events will use them.';
    if (effects.changedDays.length) {
      message += ` Updated schedule for: ${effects.changedDays.map((d) => DAY_LABELS[d]).join(', ')}.`;
    }
    return { ok: true, values: saved.value, message, warnings: [...check.warnings, ...effects.warnings] };
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
