#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load .env so values are available in process.env
require('dotenv').config();

const BAKED = 'src/baked-config.js';

// All env vars the app reads — only bake non-empty values.
// The four Discord connection values are fixed per build and never editable in
// the app. The rest are defaults the user can override in the desktop UI (the
// per-role *_MAX / *_EMOJI values seed the role list on first run).
//
// NOTE: baked values (including DISCORD_BOT_TOKEN) are stored in plain form
// inside the exe. Anyone with the file can extract them — only share a build
// with people you would trust with the bot token itself.
const KNOWN_VARS = [
  'DISCORD_BOT_TOKEN',
  'CLIENT_ID',
  'COORDINATION_CHANNEL_ID',
  'AUTO_EVENT_ENABLED',
  'AUTO_EVENT_CHANNEL_ID',
  'AUTO_EVENT_SCHEDULE',
  'AUTO_EVENT_TITLE',
  'AUTO_EVENT_DESCRIPTION',
  'AUTO_EVENT_MAINBALL_MAX',
  'AUTO_EVENT_DEF_TEAM_MAX',
  'AUTO_EVENT_COMMANDER_MAX',
  'AUTO_EVENT_SHAI_MAX',
  'AUTO_EVENT_FLEX_MAX',
  'MAINBALL_EMOJI',
  'DEF_TEAM_EMOJI',
  'COMMANDER_EMOJI',
  'SHAI_EMOJI',
  'FLEX_EMOJI',
  'DONKEY_EMOJI',
];

// Validate required vars before building
const missing = ['DISCORD_BOT_TOKEN', 'CLIENT_ID'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Build failed: missing required env vars: ${missing.join(', ')}`);
  console.error('   Set them in .env before building.\n');
  process.exit(1);
}

// Collect non-empty values
const baked = {};
for (const key of KNOWN_VARS) {
  if (process.env[key]) baked[key] = process.env[key];
}

const PLATFORM_MAP = { win32: 'win', darwin: 'macos', linux: 'linux' };
const platform = PLATFORM_MAP[process.platform] ?? process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const target = `node18-${platform}-${arch}`;

// Two editions from the same source (see src/edition.js):
//   full — the admin app with the automatic event settings
//   lite — hosting and active nodes only, for the other hosts
const EDITIONS = [
  { name: 'full', exeName: 'bdo-balenciaga.exe', extra: {} },
  { name: 'lite', exeName: 'bdo-balenciaga-lite.exe', extra: { BDO_EDITION: 'lite' } },
];

function sleepOneSecond() {
  execSync('ping 127.0.0.1 -n 2 > nul'); // ~1 s delay without requiring sleep
}

function buildOne({ name, exeName, extra }) {
  const values = { ...baked, ...extra };
  // Write temporary baked-config.js — pkg will bundle this into the binary
  fs.writeFileSync(
    BAKED,
    `// Auto-generated at build time — do not edit\nmodule.exports = ${JSON.stringify(values, null, 2)};\n`,
    'utf8'
  );

  const exePath = path.join('dist', platform === 'win' ? exeName : exeName.replace(/\.exe$/, ''));
  console.log(`\n✅ Baked ${Object.keys(values).length} config values into the ${name} edition`);
  console.log(`📦 Running pkg for ${target} → ${exePath}…\n`);

  try {
    execSync(`npx pkg . --output "${exePath}" --targets ${target}`, { stdio: 'inherit' });
  } finally {
    // Always clean up the temp file, even if pkg fails
    fs.unlinkSync(BAKED);
  }

  // Patch the PE header: change Windows subsystem from Console (3) to GUI (2).
  // A GUI-subsystem exe never allocates a console window — no runtime hiding needed.
  // Both PE32 and PE32+ have the Subsystem WORD at OptionalHeader + 0x44,
  // which is peOffset + 4 (sig) + 20 (FileHeader) + 0x44 = peOffset + 0x5C.
  if (platform === 'win') {
    // Windows Defender may briefly lock the file after pkg writes it.
    // Retry up to 5 times with 1-second gaps before giving up.
    let buf;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        buf = fs.readFileSync(exePath);
        break;
      } catch (e) {
        if (attempt === 5) throw e;
        console.log(`  Waiting for file lock to release (attempt ${attempt}/5)…`);
        sleepOneSecond();
      }
    }
    const peOff  = buf.readUInt32LE(0x3C);
    const subOff = peOff + 0x5C;
    if (buf.readUInt16LE(subOff) === 3) {
      buf.writeUInt16LE(2, subOff);
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          fs.writeFileSync(exePath, buf);
          break;
        } catch (e) {
          if (attempt === 5) throw e;
          console.log(`  Waiting for write lock to release (attempt ${attempt}/5)…`);
          sleepOneSecond();
        }
      }
      console.log(`✅ Patched ${exeName}: subsystem Console → GUI (no console window)`);
    }
  }

  // Smoke-test the packaged runtime (node18, reduced ICU) — it can crash on code
  // that works fine in the dev Node version.
  if (platform === 'win') {
    try {
      execSync(`"${exePath}" --self-test`, { stdio: 'inherit' });
      console.log(`✅ ${exeName} self-test passed`);
    } catch (e) {
      console.error(`\n❌ ${exeName} self-test failed (exit ${e.status}). Do not ship this build.`);
      process.exitCode = 1;
    }
  }
}

for (const e of EDITIONS) buildOne(e);
console.log('\n✅ Build complete — binaries are in dist/');
