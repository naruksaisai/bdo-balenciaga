const { REST, Routes } = require('discord.js');
const config = require('../config');
const { UiProcess } = require('./uiProcess');
const { DesktopController } = require('./controller');
const { NodeMonitor } = require('./nodeMonitor');
const autostart = require('./autostart');
const { connectionStatus } = require('../settings/environment');
const { checkCustomEmojis } = require('../settings/emojiCheck');
const { applySettingsChange } = require('../settings/effects');

const MAX_UI_CRASHES = 3;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 90 * 1000; // first-run Add-Type compile can be slow

// Runs the desktop UI and supervises it. If the UI process dies unexpectedly it
// is restarted; if it keeps dying, hosting is shut down cleanly and the user is
// told — the bot is never left running with no visible way to stop it.
function startDesktop({ hosting, store, startMinimized, logPath, trayLogPath, requestExit }) {
  const rest = config.token ? new REST().setToken(config.token) : null;
  const monitor = new NodeMonitor({
    isConfigured: () => !!(rest && config.coordinationChannelId),
    fetchMessages: () => rest.get(Routes.channelMessages(config.coordinationChannelId), {
      query: new URLSearchParams({ limit: '50' }),
    }),
  });

  const ui = new UiProcess({ trayLogPath });
  let exiting = false;
  let windowVisible = !startMinimized;
  let showWhenReady = false;
  let readyTimer = null;
  const crashes = [];

  const controller = new DesktopController({
    ui,
    hosting,
    store,
    monitor,
    autostart,
    connection: connectionStatus(),
    checkEmojis: (values) => checkCustomEmojis(values, { rest, eventChannelId: config.autoEvent.channelId }),
    applyChange: (prev, next) => applySettingsChange({ prev, next }, {
      scheduleConfig: require('../scheduler/scheduleConfig'),
      eventStore: require('../state/eventStore'),
      coordinator: require('../ha/coordinator'),
    }),
    requestExit: (reason, { expectUiExit }) => {
      if (expectUiExit) ui.expectExit();
      return requestExit(reason);
    },
  });

  ui.on('message', (msg) => {
    if (msg.type === 'visibility') windowVisible = msg.visible;
    if (msg.type === 'ready') {
      clearTimeout(readyTimer);
      if (showWhenReady) {
        showWhenReady = false;
        ui.send({ type: 'show' });
      }
    }
  });

  function launch({ minimized, notice }) {
    ui.start(controller.initPayload({ startMinimized: minimized, notice, logPath }));
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      if (ui.ready || exiting) return;
      console.error('[UI] UI did not start within 90 s; restarting it.');
      ui.kill({ expected: false });
    }, READY_TIMEOUT_MS);
  }

  ui.on('exit', ({ code, expected }) => {
    clearTimeout(readyTimer);
    if (expected || exiting) return;
    const now = Date.now();
    while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
    crashes.push(now);
    if (crashes.length >= MAX_UI_CRASHES) {
      console.error(`[UI] UI failed ${crashes.length} times in 10 min (last exit code ${code}); shutting down.`);
      requestExit('ui-failed', 1,
        'The BDO Raid Helper window could not be kept running, so the app has stopped hosting and closed.');
      return;
    }
    console.warn(`[UI] UI exited unexpectedly (code ${code}); restarting.`);
    setTimeout(() => {
      if (!exiting) launch({ minimized: !windowVisible, notice: 'The window was restarted after an unexpected error. Details are in the log.' });
    }, 1000);
  });

  monitor.start();
  launch({ minimized: startMinimized });

  return {
    showWindow() {
      if (ui.ready) ui.send({ type: 'show' });
      else showWhenReady = true;
    },
    async stop() {
      exiting = true;
      clearTimeout(readyTimer);
      monitor.stop();
      await ui.stop();
    },
    markExiting() {
      exiting = true;
      ui.expectExit();
    },
  };
}

module.exports = { startDesktop };
