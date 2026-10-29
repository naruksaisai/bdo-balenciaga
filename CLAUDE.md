# BDO Raid Helper — orientation for Claude

Windows desktop app (WinForms window + tray) wrapping a Discord bot for Black Desert Online raid signups.
Node.js + discord.js backend, packaged with `@yao-pkg/pkg` to a GUI-subsystem `.exe`. The UI is C#
compiled at runtime by Windows PowerShell 5.1 `Add-Type` — no extra framework. User docs: [README.md](README.md).

## Module map (read these first; everything else is derivable)

| File | Responsibility |
|---|---|
| [src/main.js](src/main.js) | Entry. Boot marker → env loading → single-instance pipe → legacy migration → settings → schedule → `Hosting` → desktop UI. `shutdown()` = graceful hosting stop, capped at 9 s. |
| [src/hosting.js](src/hosting.js) | Hosting ON/OFF lifecycle (`start`/`stop`, status `{state, role, detail, error}`). Owns the leader's Discord client; cancellable login retry with 10/30/60/120/300 s backoff. |
| [src/ha/coordinator.js](src/ha/coordinator.js) | Leader election via a Discord coordination channel. Restartable (`start`/`shutdown`, `_running` guards every async callback). Emits `role`, `promote`. |
| [src/ha/nodeStatus.js](src/ha/nodeStatus.js) | Pure parser: coord-channel messages → active/stale node counts. Shared by coordinator and UI monitor. |
| [src/settings/](src/settings/) | `schema.js` (keys, validation, precedence — pure), `settingsStore.js` (`settings.json`, hosting choice), `environment.js` (baked/env/.env/legacy config.json), `migrate.js`, `effects.js` (what a saved change does), `emojiCheck.js` (custom emoji usable by the bot?). |
| [src/desktop/](src/desktop/) | `uiProcess.js` (spawns PS, bootstrap, framing), `TrayApp.cs` (the whole UI), `ipc.js` (message whitelist), `controller.js` (UI requests → backend), `statusView.js` (display text), `nodeMonitor.js`, `singleInstance.js`, `autostart.js`, `app.js` (UI supervision/restart). |
| [src/scheduler/](src/scheduler/) | `scheduleConfig.js` (per-day schedule, `schedule.json`), `autoEvent.js` (`startAutoEvent`/`stopAutoEvent`). |
| [src/utils/dataDir.js](src/utils/dataDir.js) | Per-user data dir: `%LOCALAPPDATA%\BDO Raid Helper` (packaged), `./.data` (dev), `BDO_DATA_DIR` override. ALL mutable files go here. |
| [src/utils/baseDir.js](src/utils/baseDir.js) | exe dir (packaged) / cwd (dev). Only for reading `.env`, legacy files. Never write here. |
| [build.js](build.js) | Bakes env vars into binary, runs pkg, patches PE Console→GUI. Retries on Defender lock. |

## Build, run, test

```bash
npm start              # dev: .env from cwd, data in ./.data, window + tray
npm test               # node:test; Windows-only tests compile TrayApp.cs via real PS 5.1
npm run build          # dist/bdo-raid-helper.exe (TrayApp.cs + icon.ico are pkg assets)
node src/commands/deploy.js   # re-register slash commands
```

Run the app in a scratch cwd (no `.env`) to test the UI without touching the real bot.

## Critical constants

- `SYNC_INTERVAL_MS = 15 min` ([coordinator.js](src/ha/coordinator.js)) — leader broadcasts state
- `HEALTH_CHECK_MS = 2 min` — standby polls leader age
- `LEADER_TIMEOUT_MS = 20 min` ([nodeStatus.js](src/ha/nodeStatus.js)) — **must be > SYNC_INTERVAL**; also the "active node" threshold
- `MSG_CACHE_TTL_MS = 10s` — collapses the startup fetches into 1 HTTP call
- Node monitor polls the coord channel every 60 s with the window open, 10 min hidden

## Desktop UI ↔ Node

- Spawn: `powershell.exe -Sta -NoProfile -WindowStyle Hidden -EncodedCommand <bootstrap>` with stdio pipes. NOT `-File` (encoding ambiguity), NOT `-NonInteractive` (blocks WinForms). Bootstrap asserted < 30 000 encoded chars.
- Bootstrap reads `<byteLength>\n<TrayApp.cs UTF-8>` from stdin, `Add-Type -IgnoreWarnings` (PS 5.1 treats compiler warnings as errors), then `UiApp.Run(stdin, stdout)`.
- Protocol: one JSON object per line. Node→UI is ASCII-only (`\uXXXX`-escaped) and token-redacted. UI→Node is validated against the whitelist in [ipc.js](src/desktop/ipc.js) (types, fields, sizes, settings keys); requests carry `id` and always get a `response`.
- The UI is a thin renderer: no credentials, no hosting logic. Display strings come from [statusView.js](src/desktop/statusView.js).
- `TrayApp.cs` is C# 5 (no `$""`, `?.`, `=>` members, `out var`) and ASCII-only (test-enforced).
- PS UI log: `<data>\logs\bdo-tray.log` via `FileStream` + `FileShare.ReadWrite`. **Never `File.AppendAllText`** (conflicts with Node's open `WriteStream`).
- Windows shutdown: hidden `TrayForm` (kept from the old tray) overrides `WndProc` for `WM_ENDSESSION`, calls `ShutdownBlockReasonCreate`, sends `endSession`, waits ≤ 8 s for Node to exit.
- Single instance: per-user named pipe `\\.\pipe\bdo-raid-helper-<hash>`; second launch sends `show` and exits (`--minimized` launches just exit).

## Auto-start

- Startup-folder `.lnk` (`%APPDATA%\...\Startup\BDO Raid Helper.lnk`) with `--minimized`. HKCU Run key was unreliable on the user's box; legacy Run value is deleted on every update.
- Mirrors the hosting choice: ON creates it, OFF deletes it, startup reconciles. Skipped in dev unless `BDO_DEV_AUTOSTART=1`.

## Known gotchas (these will bite you again)

- **Fast Startup** breaks `SystemEvents.SessionEnding`. Use Form `WndProc` instead.
- **PowerShell 5.1 reads `.ps1` as ANSI without BOM**. Use `-EncodedCommand` or ASCII-only source.
- **PowerShell `$pid` is read-only** — use `$botPid` / `$nodeHostPid`.
- **`[Action]{ ... }` scriptblock casts fail silently** against `Add-Type` C# in PS 5.1. Use C# events / keep logic in C#.
- **First `ShowWindow` in the PS process gets the launcher's `SW_HIDE`** (`-WindowStyle Hidden` + `windowsHide`). `TrayApp.Run` spends it on the sink form; otherwise the main window never appears.
- **A detached `powershell.exe` exits immediately** (no console). The UI must be a normal child → it lives in libuv's kill-on-close job object and dies with Node (no orphans). Error boxes that must outlive Node are launched as a grandchild via `Start-Process` (silent job breakaway).
- **`WM_CLOSE` from outside has `CloseReason.None`**, not `UserClosing`. The main window cancels every close except `AllowClose`/`WindowsShutDown`.
- **`@discordjs/rest` clears its token after a 401**; later calls say "Expected token to be set…". Map both to "token rejected" ([discordErrors.js](src/utils/discordErrors.js)).
- **Node `WriteStream` open on a log file** blocks .NET `File.AppendAllText`.
- **Windows Defender briefly locks the new exe** after pkg writes — `build.js` retries.
- **pkg targets `node18-win-x64`** while dev runs Node 24. Keep syntax Node 18-compatible.
- **Auto-started exe has `cwd=C:\Windows\System32`** — never use `process.cwd()` for paths.
- **Login retry must never `process.exit(1)`** — a Discord outage isn't permanent.
- **Testing the GUI steals focus** — the user may be gaming on this PC. Prefer unit tests and `PrintWindow` captures; never `SetForegroundWindow`.
