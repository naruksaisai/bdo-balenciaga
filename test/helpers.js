const fs = require('fs');
const os = require('os');
const path = require('path');

// Must be called before requiring any module that reads DATA_DIR.
function useTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdo-test-'));
  process.env.BDO_DATA_DIR = dir;
  return dir;
}

module.exports = { useTempDataDir };
