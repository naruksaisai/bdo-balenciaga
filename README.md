# BDO Raid Helper

A Discord bot for Black Desert Online raid signups, packaged as a Windows desktop
app. Several guild members can run it at once: one PC is the **leader** (it runs
the bot), the others are **standbys** that take over if the leader goes offline.

## Using the app

Open `bdo-raid-helper.exe`. A window opens and an icon appears in the system tray.

- **Hosting ON/OFF.** Turns this PC's part in the cluster on or off. Hosting is
  **OFF on first launch**. The choice is remembered.
  - **ON** starts hosting now and adds the app to Windows sign-in startup. After
    sign-in it starts minimized to the tray.
  - **OFF** stops hosting cleanly (other PCs are told this host left) and removes
    sign-in startup. The window keeps working.
- **This PC's role.** Leader, Standby or Off.
- **Active nodes.** How many PCs are currently hosting. It reads the coordination
  channel directly, so it stays accurate while hosting is OFF. It refreshes every
  minute while the window is open; use **Refresh** to update it immediately.
  - **Stale** means a node hasn't sent a heartbeat for 20+ minutes.
  - **Unavailable** explains why the count couldn't be read and shows the last
    known count.
- **Automatic event.** Title, description, default time, the max players for each
  pool, and the reaction emoji for each pool. **Save** applies the changes;
  **Cancel** discards them. Invalid fields are flagged next to the field.
  - Emoji can be picked from the list, typed, or pasted. Discord custom emojis
    (`<:name:id>` or `<a:name:id>`) work if the bot is in that emoji's server. The
    app checks this with Discord on save.
  - Changes apply to **future** events. Events already posted keep their
    original emojis, so reactions on them keep working.
  - Changing the default time or a pool limit also updates days in the per-day
    schedule that still use the old default. Days customized with
    `/raid-schedule` keep their values.

**Closing the window** hides it to the tray without changing hosting. The tray
menu has **Open**, **Hosting ON/OFF**, and **Exit**. **Exit** stops hosting
cleanly and quits, but your ON/OFF choice is kept for next time.

**Opening the exe again** brings the running window to the front instead of
starting a second copy.

### Where data is stored

Settings, the per-day schedule, the state cache and the logs are stored per user
in `%LOCALAPPDATA%\BDO Raid Helper\`. The exe can live in a protected folder such
as Program Files and still runs without administrator rights.

The first time the app runs, it **copies** `schedule.json` and `state.json` from
the exe's folder into this location if they exist there (the originals are left
untouched). Editable values from an old `config.json` are adopted too.

Logs are `logs\bdo-raid-helper.log` (the app) and `logs\bdo-tray.log` (the window
host). The bot token is redacted from all logs and error messages.

## Building

1. Copy `.env.example` to `.env` and fill in the Discord connection values:
   `DISCORD_BOT_TOKEN`, `CLIENT_ID`, `AUTO_EVENT_CHANNEL_ID` and
   `COORDINATION_CHANNEL_ID`. The other values are defaults that users can
   change in the app.
2. `npm install`
3. `npm run build`. This produces `dist/bdo-raid-helper.exe`, with the UI and the
   icon packaged inside.
4. `node src/commands/deploy.js` registers the slash commands (needed once per
   bot application).

Connection values are fixed per build and cannot be edited in the app.

> **Security: the bot token is extractable.** `npm run build` embeds the token in
> the exe as plain data. Packaging hides nothing: anyone who has the exe can pull
> the token out and fully control the bot. Only give builds to people you would
> trust with the token itself. If a build leaks, reset the token in the Discord
> Developer Portal and rebuild.

### Configuration precedence

For editable settings, highest first:

1. Values saved in the app
2. Process environment
3. Values baked into the build
4. `.env`
5. Legacy `config.json`
6. Built-in defaults

An invalid value at any level falls through to the next one, and the app shows a
warning when that happens. Connection values follow the same order, except
level 1 doesn't apply to them.

## Development

```bash
npm start        # runs from source with .env; data goes to ./.data
npm test         # unit + Windows integration tests (node:test)
```

In dev mode the Startup shortcut is never created, because `node.exe` is not the
app. Set `BDO_DEV_AUTOSTART=1` to override this, and `BDO_DATA_DIR` to use
another data folder.

On non-Windows systems `npm start` runs headless and always hosts. There is no
UI there.

### What the tests cover, and what was not verified

The automated tests (`npm test`) cover:

- settings validation and precedence
- safe saves
- migration
- per-day schedule preservation
- keeping emojis compatible with existing events
- IPC message validation and token redaction
- hosting start/stop, including cancelling login retries
- node counting and status wording
- the single-instance pipe
- that the C# UI compiles under Windows PowerShell 5.1
- the stdin bootstrap round trip

These were checked manually on Windows 10 by running the app from source with a
fake connection:

- the window renders
- validation errors appear next to the right fields
- saving persists and updates the schedule
- hosting ON/OFF is persisted, and a failed login shows its reason and stops
  retrying when turned OFF
- a second launch forwards "show"
- a simulated `WM_ENDSESSION` stops hosting gracefully and both processes exit
- the UI process never outlives the backend
- the packaged exe contains the UI source and icon

**Not verified**, because it needs a real Discord bot, a real Windows sign-in or
shutdown, or several PCs:

- leader/standby failover and node counts on a live cluster
- custom emoji verification against real servers
- auto-event posting with the new settings
- the Startup shortcut being created and launching at sign-in from the packaged
  exe
- behaviour during a real Windows shutdown with Fast Startup
- the window actually coming to the front when another app holds the foreground
- the tray menu items clicked by hand
- the packaged exe running end to end
- layout at high DPI scaling
