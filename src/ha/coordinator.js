const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { REST, Routes, AttachmentBuilder } = require('discord.js');
const config = require('../config');
const { exportState, importState } = require('../state/eventStore');
const scheduleConfig = require('../scheduler/scheduleConfig');
const { DATA_DIR } = require('../utils/dataDir');
const { writeJsonAtomic } = require('../utils/safeWrite');
const { isPresenceMessage, LEADER_TIMEOUT_MS } = require('./nodeStatus');

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SYNC_INTERVAL_MS  = 15 * 60 * 1000; // 15 min  — leader broadcast cadence
const HEALTH_CHECK_MS   =  2 * 60 * 1000; //  2 min  — standby liveness poll cadence
const NODE_STALE_MS     = LEADER_TIMEOUT_MS * 2;

// Short-lived cache for channel message fetches — collapses the 4+ separate
// _getCoordMessages() calls that happen at startup into a single HTTP request.
const MSG_CACHE_TTL_MS = 10_000;
let _msgCache = null;
let _msgCacheAt = 0;

const instanceId = `node-${Date.now()}-${Math.floor(Math.random() * 9999)
  .toString()
  .padStart(4, '0')}`;

class Coordinator extends EventEmitter {
  constructor() {
    super();
    this.isLeader = false;
    this._running = false;          // false once shutdown() starts; guards async callbacks
    this._syncTimer = null;
    this._presenceMessageId = null; // this node's heartbeat message in coord channel
    this._statusMessageId = null;   // standalone status message posted when no state msg existed
    this._stateMessageId = null;    // last broadcast state message — cached so shutdown can PATCH without a fetch round-trip
    this._rest = new REST();
  }

  get running() {
    return this._running;
  }

  // ── File helpers ────────────────────────────────────────────────────────────

  _saveLocally(state) {
    try {
      writeJsonAtomic(STATE_FILE, state);
    } catch (err) {
      console.warn('[Node] Could not write state.json:', err.message);
    }
  }

  _loadLocally() {
    if (!fs.existsSync(STATE_FILE)) return null;
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      return null;
    }
  }

  // ── Discord REST helpers ─────────────────────────────────────────────────────

  async _getCoordMessages() {
    const now = Date.now();
    if (_msgCache && now - _msgCacheAt < MSG_CACHE_TTL_MS) return _msgCache;
    _msgCache = await this._rest.get(
      Routes.channelMessages(config.coordinationChannelId, { limit: 10 })
    );
    _msgCacheAt = now;
    return _msgCache;
  }

  _invalidateMsgCache() {
    _msgCache = null;
  }

  _findStateMessage(messages) {
    // Raw Discord API: attachments is an array with a `filename` field
    return messages.find(
      (m) => m.author.bot && m.attachments?.some((a) => a.filename === 'state.json')
    );
  }

  async _downloadState(url) {
    const res = await fetch(url);
    return res.json();
  }

  // ── Status card ──────────────────────────────────────────────────────────────

  // Updates the status card in the coord channel.
  // If a state message (with attachment) exists it is patched in-place so the
  // attachment is preserved for standbys still syncing.
  // If no state message exists a standalone text message is posted and its ID
  // is stored in _statusMessageId so it can be cleaned up later.
  async _updateStatusCard(content) {
    if (!config.coordinationChannelId) return;
    try {
      const messages = await this._getCoordMessages();
      const stateMsg = this._findStateMessage(messages);
      if (stateMsg) {
        await this._rest.patch(
          Routes.channelMessage(config.coordinationChannelId, stateMsg.id),
          { body: { content } }
        );
      } else {
        const msg = await this._rest.post(
          Routes.channelMessages(config.coordinationChannelId),
          { body: { content } }
        );
        this._statusMessageId = msg.id;
      }
      this._invalidateMsgCache();
    } catch (err) {
      console.warn('[Node] Failed to update status card:', err.message);
    }
  }

  // ── Presence heartbeat ───────────────────────────────────────────────────────

  async _updatePresence(role) {
    if (!config.coordinationChannelId) return;

    const content = `[NODE] \`${instanceId}\` | **${role}** | <t:${Math.floor(Date.now() / 1000)}:R>`;

    if (this._presenceMessageId) {
      try {
        await this._rest.patch(
          Routes.channelMessage(config.coordinationChannelId, this._presenceMessageId),
          { body: { content } }
        );
        return;
      } catch {
        this._presenceMessageId = null;
      }
    }

    try {
      const msg = await this._rest.post(
        Routes.channelMessages(config.coordinationChannelId),
        { body: { content } }
      );
      this._presenceMessageId = msg.id;
    } catch (err) {
      console.warn('[Node] Failed to post presence:', err.message);
    }
  }

  async _deletePresence() {
    if (!config.coordinationChannelId || !this._presenceMessageId) return;
    try {
      await this._rest.delete(Routes.channelMessage(config.coordinationChannelId, this._presenceMessageId));
      this._invalidateMsgCache();
    } catch { /* already gone */ }
    this._presenceMessageId = null;
  }

  // ── Role determination ───────────────────────────────────────────────────────

  async _getLeaderAgeMs() {
    try {
      const messages = await this._getCoordMessages();
      const msg = this._findStateMessage(messages);
      if (!msg) return Infinity;
      return Date.now() - new Date(msg.timestamp).getTime();
    } catch {
      return Infinity;
    }
  }

  // ── Dead-cluster cleanup ─────────────────────────────────────────────────────

  // Called when taking over a dead cluster (no active leader found). Deletes ALL
  // bot messages from the coord channel so that:
  //   1. The stale 🟢 state message is removed (not just patched).
  //   2. Stale standby presence messages are removed, preventing them from being
  //      counted as active nodes in the first _broadcastState of the new leader.
  // Must be called AFTER _syncFromCoordChannel() so state is already in memory.
  async _cleanupDeadCluster() {
    if (!config.coordinationChannelId) return;
    try {
      const messages = await this._getCoordMessages();
      for (const msg of messages.filter((m) => m.author.bot)) {
        await this._rest.delete(
          Routes.channelMessage(config.coordinationChannelId, msg.id)
        ).catch(() => {});
        await new Promise((r) => setTimeout(r, 600)); // stay within Discord's 5 req/5s delete limit
      }
      this._invalidateMsgCache();
      this._presenceMessageId = null;
    } catch (err) {
      console.warn('[Node] Failed to clean up dead cluster messages:', err.message);
    }
  }

  // ── Startup ──────────────────────────────────────────────────────────────────

  // Safe to call again after shutdown() — hosting can be toggled at runtime.
  async start() {
    this._running = true;
    this.isLeader = false;
    this._rest.setToken(config.token);
    this._invalidateMsgCache();

    if (!config.coordinationChannelId) {
      console.log('[Node] No COORDINATION_CHANNEL_ID set — starting as sole leader.');
      this._becomeLeader();
      return;
    }

    console.log(`[Node] Instance ID: ${instanceId}`);

    const local = this._loadLocally();
    if (local) {
      importState(local.events || {});
      console.log(
        `[Node] Loaded ${Object.keys(local.events || {}).length} events from state.json`
      );
    }

    const ageMs = await this._getLeaderAgeMs();
    if (!this._running) return;

    if (ageMs < LEADER_TIMEOUT_MS) {
      const ageMin = Math.floor(ageMs / 60000);
      console.log(`[Standby] Leader active (last sync ${ageMin}m ago). Running in standby.`);
      await this._syncFromCoordChannel().catch(() => {});
      this._runStandby();
      if (this._running) this.emit('role', 'standby');
    } else {
      console.log('[Node] No active leader found. Claiming leadership…');
      // Recover whatever state exists in the coord channel before taking over so
      // that in-flight event registrations (reactions) keep working after handoff.
      await this._syncFromCoordChannel().catch(() => {});
      // Wipe all stale bot messages (🟢 state card + dead standby presence messages)
      // so the new leader starts with a clean channel and an accurate node count.
      await this._cleanupDeadCluster().catch(() => {});
      await this._updateStatusCard([
        '⚠️ **No active host** — starting…',
        `📅 **Detected:** <t:${Math.floor(Date.now() / 1000)}:R>`,
      ].join('\n')).catch(() => {});
      this._becomeLeader();
    }
  }

  // ── Standby mode ─────────────────────────────────────────────────────────────

  async _syncFromCoordChannel() {
    const messages = await this._getCoordMessages();
    const msg = this._findStateMessage(messages);
    if (!msg) return;

    const attachment = msg.attachments.find((a) => a.filename === 'state.json');
    const state = await this._downloadState(attachment.url);

    importState(state.events || {});
    if (state.schedule) scheduleConfig.applyFull(state.schedule);
    this._saveLocally(state);
    console.log(
      `[Standby] State synced (${Object.keys(state.events || {}).length} events)`
    );

    await this._updatePresence('standby').catch(() => {});
  }

  _runStandby() {
    if (!this._running) return;
    let lastSyncAt = Date.now();

    this._syncTimer = setInterval(async () => {
      const ageMs = await this._getLeaderAgeMs().catch(() => Infinity);
      if (!this._running) return;

      if (ageMs >= LEADER_TIMEOUT_MS) {
        clearInterval(this._syncTimer);

        // Mark the status card as offline before waiting — any standby can do this
        // since it just patches the existing state message via REST
        await this._updateStatusCard([
          '🔴 **Host offline** — electing new leader…',
          `📅 **Detected:** <t:${Math.floor(Date.now() / 1000)}:R>`,
        ].join('\n')).catch(() => {});

        const jitterMs = Math.floor(Math.random() * 30000);
        console.log(
          `[Standby] Leader offline! Waiting ${Math.floor(jitterMs / 1000)}s before claiming…`
        );
        await new Promise((r) => setTimeout(r, jitterMs));
        if (!this._running) return;

        const ageAfter = await this._getLeaderAgeMs().catch(() => Infinity);
        if (ageAfter < LEADER_TIMEOUT_MS) {
          console.log('[Standby] Another node claimed leadership. Staying standby.');
          this._runStandby();
          return;
        }

        this._becomeLeader();
      } else if (Date.now() - lastSyncAt >= SYNC_INTERVAL_MS) {
        await this._syncFromCoordChannel().catch((err) =>
          console.warn('[Standby] Sync error:', err.message)
        );
        lastSyncAt = Date.now();
      }
    }, HEALTH_CHECK_MS);
  }

  _becomeLeader() {
    if (!this._running) return;
    this.isLeader = true;
    this._deletePresence().catch(() => {});
    console.log(`[Leader] This node is now the leader`);
    this.emit('role', 'leader');
    this.emit('promote');
  }

  // Called by main.js gracefulShutdown and by the tray SessionEnding handler.
  // On Windows shutdown we have ~8 seconds before the OS force-kills the
  // process, so this MUST complete in a single REST round-trip.
  //
  // We PATCH the cached state message instead of DELETE-ing it:
  //   • Single REST call (no fetch needed thanks to the cached ID).
  //   • The channel keeps a visible "🔴 No active node" indicator for humans.
  //   • Sending attachments: [] strips the state.json file so future nodes'
  //     _findStateMessage() returns null and they claim leadership immediately.
  async shutdown() {
    const wasRunning = this._running;
    this._running = false;
    this.isLeader = false;
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }

    if (this._client) {
      this._client.destroy();
      this._client = null;
    }

    if (!config.coordinationChannelId || !wasRunning) return;

    const offlineContent = [
      '🔴 **No active node** — host shut down',
      `📅 **Shut down:** <t:${Math.floor(Date.now() / 1000)}:R>`,
    ].join('\n');

    try {
      if (this._stateMessageId) {
        // Fast path: single PATCH using the cached message ID. Run in parallel
        // with standby-presence cleanup (no-op for leaders).
        await Promise.all([
          this._rest.patch(
            Routes.channelMessage(config.coordinationChannelId, this._stateMessageId),
            { body: { content: offlineContent, attachments: [] } }
          ).catch((err) => console.warn('[Node] Offline patch failed:', err.message)),
          this._deletePresence().catch(() => {}),
        ]);
        this._invalidateMsgCache();
        this._stateMessageId = null;
        console.log('[Node] State message marked offline.');
        return;
      }

      // Fallback: no cached ID (shutdown before first broadcast, or standby
      // path). Fetch the channel and patch whatever state message is there.
      const [, messages] = await Promise.all([
        this._deletePresence().catch(() => {}),
        this._getCoordMessages().catch(() => null),
      ]);
      if (!messages) return;

      const stateMsg = this._findStateMessage(messages);
      if (stateMsg) {
        await this._rest.patch(
          Routes.channelMessage(config.coordinationChannelId, stateMsg.id),
          { body: { content: offlineContent, attachments: [] } }
        );
        this._invalidateMsgCache();
        console.log('[Node] State message marked offline (via fetch).');
      }
    } catch (err) {
      console.warn('[Node] Shutdown cleanup error:', err.message);
    }
  }

  async startLeaderSync(client) {
    if (!this._running) return;
    this._client = client;

    // Clean up any standalone status message we posted before the Discord client
    // was ready (the "no active host" case where no state message existed yet)
    if (this._statusMessageId) {
      await this._rest.delete(
        Routes.channelMessage(config.coordinationChannelId, this._statusMessageId)
      ).catch(() => {});
      this._statusMessageId = null;
    }

    await this._broadcastState(client).catch(console.error);
    if (!this._running) return;

    this._syncTimer = setInterval(() => {
      this._broadcastState(client).catch(console.error);
    }, SYNC_INTERVAL_MS);
  }

  // Immediately broadcast state — called by /raid-schedule after a config update.
  broadcastNow() {
    if (!this._client) return Promise.resolve();
    return this._broadcastState(this._client);
  }

  async _broadcastState(client) {
    if (!this._running) return;
    const state = {
      syncedAt: Date.now(),
      leaderId: instanceId,
      schedule: scheduleConfig.get(),
      events: exportState(),
    };

    this._saveLocally(state);

    if (!config.coordinationChannelId) return;

    const channel = await client.channels.fetch(config.coordinationChannelId);

    const existing = await channel.messages.fetch({ limit: 20 });

    // Remove the previous state message (has attachment) — this also removes
    // the patched "host offline" content since it's on the same message
    for (const msg of existing.filter((m) => m.author.id === client.user.id && m.attachments.size > 0).values()) {
      await msg.delete().catch(() => {});
    }

    // Remove stale presence messages from nodes that went offline
    for (const msg of existing.filter((m) =>
      m.author.id === client.user.id &&
      m.attachments.size === 0 &&
      (Date.now() - (m.editedTimestamp ?? m.createdTimestamp)) >= NODE_STALE_MS
    ).values()) {
      await msg.delete().catch(() => {});
    }

    // Count standby nodes: presence heartbeats refreshed within the leader
    // timeout (same rule the desktop node monitor uses). Status cards are not nodes.
    const standbyCnt = existing.filter((m) =>
      m.author.id === client.user.id &&
      m.attachments.size === 0 &&
      isPresenceMessage(m.content) &&
      (Date.now() - (m.editedTimestamp ?? m.createdTimestamp)) < LEADER_TIMEOUT_MS
    ).size;
    const nodeCount = standbyCnt + 1; // +1 for this leader node

    const attachment = new AttachmentBuilder(
      Buffer.from(JSON.stringify(state, null, 2), 'utf8'),
      { name: 'state.json' }
    );

    if (!this._running) return;
    const sent = await channel.send({
      content: [
        `🟢 **Leader:** \`${instanceId}\``,
        `📅 **Synced:** <t:${Math.floor(Date.now() / 1000)}:R>`,
        `🖥️ **Running nodes:** ${nodeCount}`,
      ].join('\n'),
      files: [attachment],
    });
    this._stateMessageId = sent.id;

    console.log(`[Leader] State broadcast complete (${nodeCount} node(s) running)`);
  }
}

module.exports = new Coordinator();
