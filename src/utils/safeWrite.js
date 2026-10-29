const fs = require('fs');
const path = require('path');

// Antivirus / indexers briefly lock freshly written files on Windows.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write-to-temp + fsync + rename, so a crash or power loss mid-save leaves either
// the old file or the new one — never a truncated half-write.
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (!RETRY_CODES.has(err.code) || attempt >= 5) throw err;
        sleepSync(100 * attempt);
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created or already renamed */ }
    throw err;
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

// Returns { exists:false } | { exists:true, value } | { exists:true, error, movedTo }.
// A corrupt file is moved aside (not deleted) so the user's data can be recovered
// and so the next save doesn't silently overwrite it.
function readJsonFile(file) {
  if (!fs.existsSync(file)) return { exists: false };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { exists: true, error: err };
  }
  try {
    return { exists: true, value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (err) {
    const movedTo = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, movedTo); } catch { return { exists: true, error: err }; }
    return { exists: true, error: err, movedTo };
  }
}

module.exports = { writeFileAtomic, writeJsonAtomic, readJsonFile };
