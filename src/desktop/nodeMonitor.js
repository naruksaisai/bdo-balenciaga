const EventEmitter = require('events');
const { summarizeNodes } = require('../ha/nodeStatus');
const { describeDiscordError } = require('../utils/discordErrors');

const VISIBLE_INTERVAL_MS = 60 * 1000;      // while the window is open
const HIDDEN_INTERVAL_MS = 10 * 60 * 1000;  // tray only — keeps the tooltip roughly current

function describeError(err) {
  const status = err && (err.status || err.httpStatus);
  if (status === 403) return 'The bot cannot read the coordination channel.';
  if (status === 404) return 'The coordination channel was not found.';
  return describeDiscordError(err);
}

// Reads the coordination channel directly over REST, independent of hosting,
// so the node count stays accurate while hosting is OFF on this PC.
// Emits 'update' with a snapshot:
//   { available, reason, summary, checkedAt, lastSuccessAt }
class NodeMonitor extends EventEmitter {
  constructor({ fetchMessages, isConfigured, now = Date.now }) {
    super();
    this._fetch = fetchMessages;
    this._isConfigured = isConfigured;
    this._now = now;
    this._timer = null;
    this._visible = false;
    this._inflight = null;
    this.snapshot = { available: false, reason: null, summary: null, checkedAt: null, lastSuccessAt: null, loading: true };
  }

  start() {
    this._schedule(0);
  }

  stop() {
    clearTimeout(this._timer);
    this._timer = null;
  }

  setVisible(visible) {
    const wasHidden = !this._visible;
    this._visible = visible;
    // Opening the window refreshes immediately unless the data is fresh.
    const age = this.snapshot.checkedAt ? this._now() - this.snapshot.checkedAt : Infinity;
    if (visible && wasHidden && age > 15000) this._schedule(0);
    else this._schedule(this._interval());
  }

  _interval() {
    return this._visible ? VISIBLE_INTERVAL_MS : HIDDEN_INTERVAL_MS;
  }

  _schedule(ms) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.refresh().finally(() => this._schedule(this._interval()));
    }, ms);
    if (this._timer.unref) this._timer.unref();
  }

  refresh() {
    if (this._inflight) return this._inflight;
    this._inflight = this._refresh().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _refresh() {
    const checkedAt = this._now();
    const prev = this.snapshot;
    if (!this._isConfigured()) {
      this._publish({ available: false, reason: 'No coordination channel is configured in this build.', summary: null, checkedAt, lastSuccessAt: null });
      return this.snapshot;
    }
    try {
      const messages = await this._fetch();
      this._publish({ available: true, reason: null, summary: summarizeNodes(messages, this._now()), checkedAt, lastSuccessAt: checkedAt });
    } catch (err) {
      // Keep the last good summary so the UI can show it, marked as stale.
      this._publish({ available: false, reason: describeError(err), summary: prev.summary, checkedAt, lastSuccessAt: prev.lastSuccessAt });
    }
    return this.snapshot;
  }

  _publish(snapshot) {
    this.snapshot = { ...snapshot, loading: false };
    this.emit('update', this.snapshot);
  }
}

module.exports = { NodeMonitor, describeError, VISIBLE_INTERVAL_MS, HIDDEN_INTERVAL_MS };
