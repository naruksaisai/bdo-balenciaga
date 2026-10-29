const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../utils/safeWrite');

// Files that older versions kept next to the exe (or in the dev cwd).
const LEGACY_FILES = ['schedule.json', 'state.json'];

// Copies legacy data files into the per-user data dir. Never overwrites a file
// already in the data dir and never deletes the original (the exe folder may be
// read-only, and keeping it makes a downgrade possible). Unparseable files are
// skipped so a corrupt legacy file can't replace good defaults.
function migrateLegacyFiles({ legacyDir, dataDir }) {
  const results = [];
  if (path.resolve(legacyDir) === path.resolve(dataDir)) return results;
  for (const name of LEGACY_FILES) {
    const src = path.join(legacyDir, name);
    const dst = path.join(dataDir, name);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^﻿/, ''));
      writeJsonAtomic(dst, value);
      results.push({ name, status: 'migrated' });
    } catch (err) {
      results.push({ name, status: 'skipped', reason: err.message });
    }
  }
  return results;
}

module.exports = { migrateLegacyFiles, LEGACY_FILES };
