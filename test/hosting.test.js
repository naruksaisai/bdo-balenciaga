const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { useTempDataDir } = require('./helpers');

useTempDataDir();
const { Hosting } = require('../src/hosting');

// Hosting's console.log output (e.g. "✅ … online") goes to the test child's
// stdout, which `node --test` also parses; on Node 24 that intermittently
// fails with "Unable to deserialize cloned data". Nothing here asserts on it.
console.log = () => {};

class FakeCoordinator extends EventEmitter {
  constructor(role) {
    super();
    this.role = role;
    this.shutdowns = 0;
    this.isLeader = false;
  }
  async start() {
    this.running = true;
    if (this.role === 'leader') { this.emit('role', 'leader'); this.emit('promote'); }
    else this.emit('role', 'standby');
  }
  async startLeaderSync() {}
  async shutdown() { this.running = false; this.shutdowns++; }
}

class FakeClient extends EventEmitter {
  constructor(failures) {
    super();
    this.failures = failures;
    this.logins = 0;
    this.destroyed = false;
    this.user = { tag: 'Bot#0001' };
  }
  async login() {
    this.logins++;
    if (this.logins <= this.failures) throw new Error('getaddrinfo ENOTFOUND discord.com');
    setImmediate(() => this.emit('ready'));
  }
  async destroy() { this.destroyed = true; }
}

const autoEvent = () => ({ started: 0, stopped: 0, startAutoEvent() { this.started++; }, stopAutoEvent() { this.stopped++; } });
const tick = () => new Promise((r) => setImmediate(r));

test('standby: start → running/standby, stop → stopped/off', async () => {
  const coordinator = new FakeCoordinator('standby');
  const h = new Hosting({ coordinator, createClient: () => new FakeClient(0), autoEvent: autoEvent(), config: { token: 't' } });
  await h.start();
  assert.deepEqual([h.status.state, h.status.role], ['running', 'standby']);
  await h.stop();
  assert.deepEqual([h.status.state, h.status.role], ['stopped', 'off']);
  assert.equal(coordinator.shutdowns, 1);
});

test('leader: connects, starts the scheduler, and stops cleanly', async () => {
  const coordinator = new FakeCoordinator('leader');
  const ae = autoEvent();
  let client;
  const h = new Hosting({ coordinator, createClient: () => (client = new FakeClient(0)), autoEvent: ae, config: { token: 't' } });
  await h.start();
  await tick(); await tick();
  assert.deepEqual([h.status.state, h.status.role], ['running', 'leader']);
  assert.equal(ae.started, 1);
  await h.stop();
  assert.equal(client.destroyed, true);
  assert.equal(ae.stopped, 1);
  assert.equal(h.status.role, 'off');
});

test('login keeps retrying (never exits) and stop cancels the retry loop', async () => {
  const coordinator = new FakeCoordinator('leader');
  let client;
  const h = new Hosting({
    coordinator, createClient: () => (client = new FakeClient(Infinity)), autoEvent: autoEvent(),
    config: { token: 't' }, retryDelays: [0.01],
  });
  await h.start();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(client.logins >= 2, 'retried');
  assert.match(h.status.detail, /Retrying/);
  await h.stop();
  const logins = client.logins;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.logins, logins, 'no more attempts after stop');
});

test('hosting can be turned on again after being turned off', async () => {
  const coordinator = new FakeCoordinator('standby');
  const h = new Hosting({ coordinator, createClient: () => new FakeClient(0), autoEvent: autoEvent(), config: { token: 't' } });
  await h.start();
  await h.stop();
  await h.start();
  assert.equal(h.status.state, 'running');
  assert.equal(coordinator.running, true);
});
