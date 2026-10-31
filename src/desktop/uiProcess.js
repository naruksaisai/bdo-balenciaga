const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseUiMessage, serializeForUi, MAX_LINE_BYTES } = require('./ipc');
const { redact } = require('../utils/logger');

// Packaged into the exe as pkg assets (see package.json "pkg.assets").
const UI_SOURCE_FILE = path.join(__dirname, 'TrayApp.cs');
const ICON_FILE = path.join(__dirname, '..', '..', 'icon.ico');

// PowerShell side of the bridge. Kept tiny and ASCII-only: it reads the C# UI
// source from stdin (length-prefixed, so nothing past it is buffered away from
// the UI's own reader), compiles it with Add-Type and hands it stdin/stdout.
// Passed via -EncodedCommand (UTF-16LE base64) — never -File, whose encoding
// PowerShell 5.1 guesses as ANSI.
function buildBootstrap(trayLogPath) {
  const pse = (s) => s.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$trayLog = "${pse(trayLogPath)}"
function Write-TrayLog([string]$line) {
  try {
    $fs = [System.IO.File]::Open($trayLog, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $sw = New-Object System.IO.StreamWriter($fs, [System.Text.Encoding]::UTF8)
    $sw.WriteLine("[$(Get-Date -Format 'o')] $line")
    $sw.Close(); $fs.Close()
  } catch {}
}
try {
  $stdinStream = [Console]::OpenStandardInput()
  $header = New-Object System.Text.StringBuilder
  while ($true) {
    $b = $stdinStream.ReadByte()
    if ($b -lt 0) { Write-TrayLog "stdin closed before UI source arrived"; exit 3 }
    if ($b -eq 10) { break }
    [void]$header.Append([char]$b)
  }
  $len = [int]$header.ToString()
  $buf = New-Object byte[] $len
  $off = 0
  while ($off -lt $len) {
    $n = $stdinStream.Read($buf, $off, $len - $off)
    if ($n -le 0) { Write-TrayLog "stdin closed mid-source"; exit 4 }
    $off += $n
  }
  $src = [System.Text.Encoding]::UTF8.GetString($buf)
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions
  Add-Type -IgnoreWarnings -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions -TypeDefinition $src
  Write-TrayLog "UI compiled (PS PID $PID)"
  $code = [BdoBalenciaga.UiApp]::Run($stdinStream, [Console]::OpenStandardOutput())
  Write-TrayLog "UI exited with code $code"
  exit $code
} catch {
  Write-TrayLog "ERROR: $($_.Exception.Message)"
  [Console]::Error.WriteLine("UI bootstrap error: " + $_.Exception.Message)
  exit 2
}
`;
}

function encodeCommand(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // CreateProcessW caps the command line at ~32 KB. Fail loud, not silently.
  if (encoded.length > 30000) {
    throw new Error(`UI bootstrap too large for -EncodedCommand: ${encoded.length} chars`);
  }
  return encoded;
}

function loadUiSource() {
  const src = fs.readFileSync(UI_SOURCE_FILE, 'utf8');
  // Non-ASCII C# source would be at the mercy of code pages; keep it out.
  if (/[^\x00-\x7f]/.test(src)) throw new Error('TrayApp.cs must be ASCII-only');
  return src;
}

function loadIconBase64() {
  try {
    return fs.readFileSync(ICON_FILE).toString('base64');
  } catch {
    return null; // UI falls back to the default application icon
  }
}

// One UI process (PowerShell hosting the WinForms tray + window).
// Emits: 'message' (validated UI message), 'exit' ({ code, expected }).
class UiProcess extends EventEmitter {
  constructor({ trayLogPath, spawnFn = spawn } = {}) {
    super();
    this._trayLogPath = trayLogPath;
    this._spawn = spawnFn;
    this._proc = null;
    this._expectExit = false;
    this.ready = false;
  }

  get running() {
    return !!this._proc;
  }

  start(init) {
    if (this._proc) return;
    this._expectExit = false;
    this.ready = false;
    const encoded = encodeCommand(buildBootstrap(this._trayLogPath));
    const proc = this._spawn('powershell.exe', [
      '-Sta', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
    // Not detached: a detached powershell.exe has no console and exits at once.
    // As a normal child it lives in libuv's kill-on-close job object, so the UI
    // can never outlive Node (no orphaned tray icon).
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this._proc = proc;

    let buffered = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE_BYTES * 2 && !buffered.includes('\n')) {
        console.warn('[UI] Dropping oversized message from UI process');
        buffered = '';
        return;
      }
      let nl;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).replace(/\r$/, '');
        buffered = buffered.slice(nl + 1);
        if (line) this._onLine(line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text && !text.startsWith('#< CLIXML')) console.warn('[UI] stderr:', text.slice(0, 2000));
    });
    proc.stdin.on('error', () => { /* UI exited; 'exit' handles it */ });
    proc.on('error', (err) => console.error('[UI] Failed to start UI process:', err.message));
    proc.on('exit', (code) => {
      if (this._proc !== proc) return;
      this._proc = null;
      this.ready = false;
      this.emit('exit', { code, expected: this._expectExit });
    });

    const source = Buffer.from(loadUiSource(), 'utf8');
    proc.stdin.write(`${source.length}\n`);
    proc.stdin.write(source);
    this.send({ type: 'init', icon: loadIconBase64(), ...init });
  }

  _onLine(line) {
    const r = parseUiMessage(line);
    if (!r.ok) {
      console.warn(`[UI] Rejected message: ${r.error}`);
      if (r.id !== undefined) this.send({ type: 'response', id: r.id, ok: false, error: 'Request rejected by the background process.' });
      return;
    }
    if (r.message.type === 'ready') this.ready = true;
    this.emit('message', r.message);
  }

  send(msg) {
    if (!this._proc || !this._proc.stdin.writable) return false;
    try {
      this._proc.stdin.write(serializeForUi(msg) + '\n');
      return true;
    } catch (err) {
      console.warn('[UI] Send failed:', redact(err.message));
      return false;
    }
  }

  // Asks the UI to close; kills it if it hasn't exited within `graceMs`.
  stop(graceMs = 3000) {
    const proc = this._proc;
    if (!proc) return Promise.resolve();
    this._expectExit = true;
    this.send({ type: 'quit' });
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        try { proc.kill(); } catch { /* already gone */ }
        resolve();
      }, graceMs);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  // The UI was told to exit some other way (e.g. Windows is ending the session).
  expectExit() {
    this._expectExit = true;
  }

  // expected:false → the 'exit' event reports a failure (supervisor restarts it).
  kill({ expected = true } = {}) {
    if (this._proc) {
      this._expectExit = expected;
      try { this._proc.kill(); } catch { /* already gone */ }
    }
  }
}

// Last-resort visible error (UI can't be kept running, or Node is crashing).
// Must outlive this process: our direct children are killed with us (libuv job
// object), and a detached powershell.exe exits immediately for lack of a
// console. So a short-lived child uses Start-Process to launch the message box
// as a grandchild, which silently breaks away from the job.
// Resolves once the box has been launched (callers wait before exiting).
function showFatalMessageBox(text) {
  if (process.platform !== 'win32') return Promise.resolve();
  const q = (s) => s.replace(/'/g, "''");
  const box = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('${q(redact(text))}', 'BDO Balenciaga', 'OK', 'Error')`;
  const launcher = `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-Sta','-EncodedCommand','${encodeCommand(box)}'`;
  return new Promise((resolve) => {
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeCommand(launcher)], {
        windowsHide: true, stdio: 'ignore',
      });
      const t = setTimeout(resolve, 5000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
      child.on('error', () => { clearTimeout(t); resolve(); });
    } catch {
      resolve(); // nothing else we can do
    }
  });
}

module.exports = { UiProcess, buildBootstrap, encodeCommand, loadUiSource, showFatalMessageBox, UI_SOURCE_FILE };
