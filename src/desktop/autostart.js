const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Auto-start uses a Startup folder .lnk instead of the HKCU\...\Run registry key
// because Run keys were silently failing to launch the exe on this user's
// Windows install despite a correct registry value. Startup folder is the
// canonical per-user auto-start surface (no admin rights) and behaves
// identically across Fast Startup, normal boot, and resume.
//
// The shortcut passes --minimized so sign-in starts straight to the tray.

const LEGACY_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LEGACY_REG_NAME = 'BDORaidHelper';
const LEGACY_LNK_NAME = 'BDO Raid Helper.lnk'; // before the rename to BDO Balenciaga
const AUTOSTART_ARGS = '--minimized';

const isPackaged = () => typeof process.pkg !== 'undefined';

function startupLnkPath(name = 'BDO Balenciaga.lnk') {
  return path.join(
    process.env.APPDATA || '',
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    name
  );
}

// Single-quote escape for PowerShell string literals
const psQ = (s) => s.replace(/'/g, "''");

function runPs(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Reads the .lnk's TargetPath and Arguments via WScript.Shell.
function readShortcut(lnk) {
  try {
    const out = runPs(
      `try { $s = (New-Object -ComObject WScript.Shell).CreateShortcut('${psQ(lnk)}'); ` +
      `[Console]::Out.Write($s.TargetPath + '|' + $s.Arguments) } catch {}`
    );
    const [target = '', args = ''] = out.trim().split('|');
    return { target: target.toLowerCase(), args };
  } catch {
    return { target: '', args: '' };
  }
}

function isAutoStartEnabled() {
  const lnk = startupLnkPath();
  if (!fs.existsSync(lnk)) return false;
  // Also check that the shortcut points at the current exe — a moved install
  // would otherwise silently keep launching the stale path.
  const s = readShortcut(lnk);
  return s.target === process.execPath.toLowerCase() && s.args.trim() === AUTOSTART_ARGS;
}

function removeLegacyRunKey() {
  try {
    execFileSync('reg.exe', ['query', LEGACY_REG_KEY, '/v', LEGACY_REG_NAME],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // It exists — delete it so we don't double-launch.
    execFileSync('reg.exe', ['delete', LEGACY_REG_KEY, '/v', LEGACY_REG_NAME, '/f'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    console.log('[AutoStart] Removed legacy Run key (migrated to Startup folder).');
  } catch { /* not present — fine */ }
}

// The pre-rename shortcut points at the old exe; drop it so it can't double-launch.
function removeLegacyShortcut() {
  try {
    fs.unlinkSync(startupLnkPath(LEGACY_LNK_NAME));
    console.log('[AutoStart] Removed pre-rename startup shortcut.');
  } catch { /* not present — fine */ }
}

// Returns { ok:true } or { ok:false, error }. Hosting ON ⇒ enabled.
function setAutoStart(enabled) {
  if (process.platform !== 'win32') return { ok: true };
  removeLegacyRunKey();
  // In dev, execPath is node.exe — a shortcut to it would launch nothing useful.
  if (!isPackaged() && process.env.BDO_DEV_AUTOSTART !== '1') {
    console.log(`[AutoStart] Skipped in dev mode (would set ${enabled ? 'ON' : 'OFF'}).`);
    return { ok: true, skipped: true };
  }
  removeLegacyShortcut();
  const lnk = startupLnkPath();
  try {
    if (!enabled) {
      if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
      return { ok: true };
    }
    if (isAutoStartEnabled()) return { ok: true };
    const exe = process.execPath;
    runPs(
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${psQ(lnk)}');` +
      `$s.TargetPath = '${psQ(exe)}';` +
      `$s.Arguments = '${AUTOSTART_ARGS}';` +
      `$s.WorkingDirectory = '${psQ(path.dirname(exe))}';` +
      `$s.IconLocation = '${psQ(exe)},0';` +
      `$s.Description = 'BDO Balenciaga Discord bot';` +
      `$s.Save()`
    );
    console.log('[AutoStart] Startup shortcut created.');
    return { ok: true };
  } catch (err) {
    console.warn('[AutoStart] Update failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { setAutoStart, isAutoStartEnabled, startupLnkPath, AUTOSTART_ARGS };
