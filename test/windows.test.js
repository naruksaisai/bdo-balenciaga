// Windows-only integration tests: named-pipe single instance, and the real
// PowerShell + Add-Type UI bridge (compile + JSON round trip, no window shown).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { buildBootstrap, encodeCommand, loadUiSource, UI_SOURCE_FILE } = require('../src/desktop/uiProcess');
const singleInstance = require('../src/desktop/singleInstance');

const win = process.platform === 'win32';

test('UI source is ASCII-only and the bootstrap fits in -EncodedCommand', () => {
  assert.doesNotThrow(loadUiSource);
  const encoded = encodeCommand(buildBootstrap('C:\\Users\\Ünïcode\\bdo-tray.log'));
  assert.ok(encoded.length < 30000);
  assert.ok(!/\$pid\s*=/i.test(buildBootstrap('x')), 'PowerShell $pid is read-only');
});

test('second instance is detected and forwards "show"', { skip: !win }, async () => {
  const name = `\\\\.\\pipe\\bdo-test-${crypto.randomBytes(6).toString('hex')}`;
  const received = [];
  const first = await singleInstance.acquire({ name, onCommand: (c) => received.push(c) });
  assert.equal(first.primary, true);
  const second = await singleInstance.acquire({ name });
  assert.equal(second.primary, false);
  assert.equal(await second.notify('show'), true);
  assert.equal(await second.notify('rm -rf'), false, 'unknown commands are refused');
  assert.deepEqual(received, ['show']);
  await first.close();
  const third = await singleInstance.acquire({ name });
  assert.equal(third.primary, true, 'pipe is released when the owner closes');
  await third.close();
});

test('TrayApp.cs compiles with Windows PowerShell 5.1 Add-Type', { skip: !win, timeout: 120000 }, () => {
  const ps = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions
$src = [System.IO.File]::ReadAllText($env:BDO_UI_SRC)
Add-Type -IgnoreWarnings -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions -TypeDefinition $src
[Console]::Out.Write('OK:' + ('BdoBalenciaga.UiApp' -as [Type]).FullName)`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encodeCommand(ps)], {
    env: { ...process.env, BDO_UI_SRC: UI_SOURCE_FILE }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(out.trim(), 'OK:BdoBalenciaga.UiApp');
});

test('bootstrap delivers source over stdin and the bridge round-trips JSON', { skip: !win, timeout: 120000 }, async () => {
  // A stand-in UiApp that echoes each message back — exercises the real
  // bootstrap framing and the UTF-8 stream setup without opening a window.
  const echo = `
using System; using System.IO; using System.Text;
namespace BdoBalenciaga { public static class UiApp {
  public static int Run(Stream input, Stream output) {
    var r = new StreamReader(input, new UTF8Encoding(false));
    var w = new StreamWriter(output, new UTF8Encoding(false)); w.AutoFlush = true;
    string line; while ((line = r.ReadLine()) != null) { w.Write(line + "\\n"); }
    return 0;
  } } }`;
  const proc = spawn('powershell.exe', ['-Sta', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand',
    encodeCommand(buildBootstrap(require('path').join(require('os').tmpdir(), 'bdo-test-tray.log')))],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const src = Buffer.from(echo, 'utf8');
  proc.stdin.write(`${src.length}\n`);
  proc.stdin.write(src);
  proc.stdin.write('{"type":"x","v":"\\u2694\\ufe0f"}\n');
  const line = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) resolve(buf.split('\n')[0]);
    });
    proc.on('exit', (code) => reject(new Error(`exited ${code}`)));
  });
  proc.stdin.end();
  assert.equal(JSON.parse(line).v, '⚔️');
  const code = await new Promise((r) => proc.on('exit', r));
  assert.equal(code, 0);
});
