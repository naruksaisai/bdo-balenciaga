const path = require('path');

// Run by build.js against the packaged exe: exercises code that has crashed
// only in pkg's node18 runtime (e.g. Intl.Segmenter segfaulted) and exits.
if (process.argv.includes('--self-test')) {
  try {
    const schema = require('./settings/schema');
    if (!schema.validateSettings(schema.resolveSettings({}).values).ok) throw new Error('defaults invalid');
    if (!require('./settings/roles').validateRoles(schema.resolveLegacyRoles({})).ok) throw new Error('default roles invalid');
    require('./desktop/uiProcess').loadUiSource();
    require('./hosting');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`self-test failed: ${err.stack || err}\n`);
    process.exit(1);
  }
}

const { DATA_DIR, LOG_DIR } = require('./utils/dataDir');
const logger = require('./utils/logger');

// Earliest-possible boot marker — written before anything else can crash.
logger.writeBootMarker(LOG_DIR);

const isPackaged = typeof process.pkg !== 'undefined';
const BASE_DIR = require('./utils/baseDir');

// The packaged GUI exe has no console: everything goes to the log file (with
// the bot token redacted). Dev runs keep console output too.
const LOG_FILE = logger.installFileLogging(LOG_DIR, { mirrorToConsole: !isPackaged });
// Separate log for the PowerShell UI host, written with FileShare.ReadWrite so it
// never conflicts with Node's WriteStream on bdo-raid-helper.log.
const TRAY_LOG_FILE = path.join(LOG_DIR, 'bdo-tray.log');

// readline SIGINT bridge — only useful when a real console is attached (dev mode).
if (process.platform === 'win32' && !isPackaged && process.stdin.isTTY) {
  require('readline').createInterface({ input: process.stdin, output: process.stdout })
    .on('SIGINT', () => process.emit('SIGINT'));
}

let _shutdown = null;
let hosting = null;
let desktop = null;
let instance = null;

// Stops hosting cleanly (marks this host offline in Discord), closes the UI,
// then exits. Hard-capped so Windows shutdown can never hang on us.
// fatalMessage: shown to the user in an error box that outlives this process.
function shutdown(reason, code = 0, fatalMessage = null) {
  if (_shutdown) return _shutdown;
  console.log(`[Node] Shutting down (${reason})…`);
  setTimeout(() => process.exit(code), 9000).unref();
  _shutdown = (async () => {
    const box = fatalMessage
      ? require('./desktop/uiProcess').showFatalMessageBox(`${fatalMessage}\n\nDetails are in the log file:\n${LOG_FILE}`)
      : null;
    if (desktop) desktop.markExiting();
    try { if (hosting) await hosting.stop(); } catch (err) { console.warn('[Node] Hosting stop error:', err.message); }
    try { if (desktop) await desktop.stop(); } catch { /* best-effort */ }
    try { if (instance && instance.close) await instance.close(); } catch { /* best-effort */ }
    await box;
    process.exit(code);
  })();
  return _shutdown;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[Node] Uncaught exception:', err);
  shutdown('uncaughtException', 1,
    `BDO Raid Helper hit an unexpected error and stopped hosting on this PC.\n\n${err && err.message}`);
});
process.on('unhandledRejection', (err) => {
  console.error('[Node] Unhandled rejection:', err);
});

async function main() {
  const startMinimized = process.argv.includes('--minimized');
  console.log(`[Node] Data directory: ${DATA_DIR}`);

  // 1. Connection + default values: environment → baked → .env → legacy config.json
  const { loadEnvironment, connectionStatus } = require('./settings/environment');
  const { legacySettings } = loadEnvironment({ baseDir: BASE_DIR });
  console.log(`[Node] Edition: ${require('./edition').edition()}`);

  // 2. One running copy per Windows user; a second launch just shows the window.
  if (process.platform === 'win32') {
    instance = await require('./desktop/singleInstance').acquire({
      onCommand: (cmd) => { if (cmd === 'show' && desktop) desktop.showWindow(); },
    });
    if (!instance.primary) {
      console.log('[Node] Already running — asking the existing window to come forward.');
      if (!startMinimized) await instance.notify('show');
      process.exit(0);
    }
  }

  // 3. Move data that older versions kept next to the exe into the user data dir.
  for (const r of require('./settings/migrate').migrateLegacyFiles({ legacyDir: BASE_DIR, dataDir: DATA_DIR })) {
    console.log(`[Migrate] ${r.name}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
  }

  // 4. User settings (hosting choice defaults to OFF on first launch).
  const store = require('./settings/settingsStore').load({ legacySettings });
  for (const w of store.getView().warnings) console.warn('[Settings]', w);

  // 5. Per-day schedule (creates schedule.json from defaults if missing).
  require('./scheduler/scheduleConfig').init();

  const conn = connectionStatus();
  if (!conn.ok) console.warn(`[Node] Discord connection incomplete — missing ${conn.missing.join(', ')}.`);

  const { Hosting } = require('./hosting');
  hosting = new Hosting();
  hosting.on('status', (s) => console.log(`[Hosting] ${s.state} / ${s.role}${s.detail ? ` — ${s.detail}` : ''}`));

  if (process.platform !== 'win32') {
    // No desktop UI off Windows: run headless and always host (dev convenience).
    if (conn.ok) await hosting.start();
    return;
  }

  // 6. Desktop UI. Auto-start (Startup shortcut) mirrors the hosting choice.
  const autostart = require('./desktop/autostart');
  autostart.setAutoStart(store.isHostingEnabled());
  desktop = require('./desktop/app').startDesktop({
    hosting,
    store,
    startMinimized,
    logPath: LOG_FILE,
    trayLogPath: TRAY_LOG_FILE,
    requestExit: (reason, code, fatalMessage) => shutdown(reason, code, fatalMessage),
  });

  if (store.isHostingEnabled() && conn.ok) hosting.start();
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  shutdown('startup-failure', 1, `BDO Raid Helper could not start: ${err.message}`);
});
