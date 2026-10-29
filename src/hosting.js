const EventEmitter = require('events');
const { redact } = require('./utils/logger');

// Retry delays in seconds: 10s, 30s, 60s, 120s, then cap at 300s
const LOGIN_RETRY_DELAYS = [10, 30, 60, 120, 300];
const STOP_TIMEOUT_MS = 7000; // Windows gives ~8 s on shutdown; leave margin

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
}

function createDiscordClient() {
  const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
  const createEvent = require('./commands/createEvent');
  const raidSchedule = require('./commands/raidSchedule');
  const handleReactionAdd = require('./handlers/reactionAdd');
  const handleReactionRemove = require('./handlers/reactionRemove');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  client.commands = new Collection();
  client.commands.set(createEvent.data.name, createEvent);
  client.commands.set(raidSchedule.data.name, raidSchedule);

  client.on('error', (err) => console.error('[Bot] Client error:', err.message));

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      const reply = { content: '❌ An error occurred while executing that command.', ephemeral: true };
      interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply);
    }
  });

  const safe = (handler) => (...args) => handler(...args).catch((err) =>
    console.error('[Bot] Reaction handler error:', err.message));
  client.on('messageReactionAdd', safe(handleReactionAdd));
  client.on('messageReactionRemove', safe(handleReactionRemove));
  return client;
}

// Runs (or stops) this PC's participation in the bot cluster. Emits 'status'
// with { state, role, detail, error } whenever anything changes.
//   state: 'stopped' | 'starting' | 'running' | 'stopping'
//   role:  'off' | 'standby' | 'leader'
class Hosting extends EventEmitter {
  constructor({
    coordinator = require('./ha/coordinator'),
    createClient = createDiscordClient,
    autoEvent = require('./scheduler/autoEvent'),
    config = require('./config'),
    retryDelays = LOGIN_RETRY_DELAYS,
  } = {}) {
    super();
    this._coordinator = coordinator;
    this._createClient = createClient;
    this._autoEvent = autoEvent;
    this._config = config;
    this._retryDelays = retryDelays;
    this._gen = 0;          // bumped on every start/stop; stale async work checks it
    this._client = null;
    this._wake = null;      // resolves the current retry sleep early on stop
    this._status = { state: 'stopped', role: 'off', detail: '', error: null };

    coordinator.on('role', (role) => {
      if (role === 'standby' && this._status.state === 'starting') {
        this._set({ state: 'running', role: 'standby', detail: 'Standing by — another PC is the active leader.' });
      }
    });
    coordinator.on('promote', () => this._startLeader(this._gen));
  }

  get status() {
    return { ...this._status };
  }

  _set(patch) {
    this._status = { ...this._status, ...patch };
    this.emit('status', this.status);
  }

  async start() {
    if (this._status.state === 'starting' || this._status.state === 'running') return;
    if (this._status.state === 'stopping') await this._stopping;
    const gen = ++this._gen;
    this._set({ state: 'starting', role: 'off', detail: 'Checking for an active leader…', error: null });
    try {
      await this._coordinator.start();
    } catch (err) {
      if (gen !== this._gen) return;
      console.error('[Hosting] Start failed:', err.message);
      // The coordinator could not determine the cluster state; hosting stays
      // requested but idle so the user sees the failure and can retry.
      await this.stop();
      this._set({ error: `Could not start hosting: ${redact(err.message)}` });
    }
  }

  stop() {
    if (this._status.state === 'stopped') return Promise.resolve();
    if (this._status.state === 'stopping') return this._stopping;
    this._gen++;
    if (this._wake) this._wake();
    this._set({ state: 'stopping', detail: 'Stopping — telling other PCs this host is going offline…' });
    this._stopping = (async () => {
      try { this._autoEvent.stopAutoEvent(); } catch { /* best-effort */ }
      await withTimeout(this._coordinator.shutdown().catch((err) =>
        console.warn('[Hosting] Coordinator shutdown error:', err.message)), STOP_TIMEOUT_MS);
      if (this._client) {
        try { await this._client.destroy(); } catch { /* already gone */ }
        this._client = null;
      }
      this._set({ state: 'stopped', role: 'off', detail: '', error: null });
      this._stopping = null;
    })();
    return this._stopping;
  }

  _startLeader(gen) {
    if (gen !== this._gen) return;
    const client = this._createClient();
    this._client = client;
    this._set({ state: 'starting', role: 'leader', detail: 'Connecting to Discord…' });

    client.once('ready', async () => {
      if (gen !== this._gen) return;
      console.log(`✅ BDO Raid Helper online as ${client.user.tag}`);
      this._set({ state: 'running', role: 'leader', detail: `Hosting as ${client.user.tag}.`, error: null });
      await this._coordinator.startLeaderSync(client);
      if (gen === this._gen) this._autoEvent.startAutoEvent(client);
    });

    this._loginWithRetry(client, gen);
  }

  // A Discord outage isn't permanent: keep retrying with backoff and never exit.
  async _loginWithRetry(client, gen) {
    for (let attempt = 1; gen === this._gen; attempt++) {
      try {
        await client.login(this._config.token);
        return;
      } catch (err) {
        if (gen !== this._gen) return;
        const delay = this._retryDelays[Math.min(attempt - 1, this._retryDelays.length - 1)];
        const msg = redact(err.message);
        console.error(`[Bot] Login attempt ${attempt} failed: ${msg}. Retrying in ${delay}s…`);
        this._set({ detail: `Discord login failed (${msg}). Retrying in ${delay}s…` });
        await new Promise((resolve) => {
          const t = setTimeout(resolve, delay * 1000);
          this._wake = () => { clearTimeout(t); resolve(); };
        });
        this._wake = null;
      }
    }
  }
}

module.exports = { Hosting, createDiscordClient, withTimeout, STOP_TIMEOUT_MS };
