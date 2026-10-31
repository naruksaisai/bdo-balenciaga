const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic, readJsonFile } = require('../src/utils/safeWrite');
const { migrateLegacyFiles } = require('../src/settings/migrate');
const { loadEnvironment } = require('../src/settings/environment');
const { resolveDataDir } = require('../src/utils/dataDir');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bdo-files-'));

test('atomic write replaces content and leaves no temp files', () => {
  const dir = tmp();
  const file = path.join(dir, 'nested', 'a.json');
  writeJsonAtomic(file, { v: 1 });
  writeJsonAtomic(file, { v: 2 });
  assert.deepEqual(readJsonFile(file).value, { v: 2 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['a.json']);
});

test('readJsonFile reports missing files and tolerates a BOM', () => {
  const dir = tmp();
  assert.deepEqual(readJsonFile(path.join(dir, 'none.json')), { exists: false });
  fs.writeFileSync(path.join(dir, 'bom.json'), '\uFEFF{"a":1}');
  assert.deepEqual(readJsonFile(path.join(dir, 'bom.json')).value, { a: 1 });
});

test('migration copies valid legacy files, never overwrites, keeps originals', () => {
  const legacy = tmp();
  const data = tmp();
  fs.writeFileSync(path.join(legacy, 'schedule.json'), JSON.stringify({ monday: { enabled: true } }));
  fs.writeFileSync(path.join(legacy, 'state.json'), '{ broken');
  fs.writeFileSync(path.join(data, 'other.json'), '{}');

  const r = migrateLegacyFiles({ legacyDir: legacy, dataDir: data });
  assert.deepEqual(r.map((x) => [x.name, x.status]), [['schedule.json', 'migrated'], ['state.json', 'skipped']]);
  assert.ok(fs.existsSync(path.join(legacy, 'schedule.json')), 'original kept');
  assert.ok(!fs.existsSync(path.join(data, 'state.json')), 'corrupt file not copied');

  fs.writeFileSync(path.join(legacy, 'schedule.json'), JSON.stringify({ tuesday: {} }));
  assert.deepEqual(migrateLegacyFiles({ legacyDir: legacy, dataDir: data }), [{ name: 'state.json', status: 'skipped', reason: r[1].reason }]);
  assert.deepEqual(readJsonFile(path.join(data, 'schedule.json')).value, { monday: { enabled: true } }, 'not overwritten');
});

test('environment precedence: env > baked > .env > legacy config.json', () => {
  const base = tmp();
  const keys = ['CLIENT_ID', 'COORDINATION_CHANNEL_ID', 'AUTO_EVENT_CHANNEL_ID', 'AUTO_EVENT_TITLE', 'AUTO_EVENT_SHAI_MAX', 'AUTO_EVENT_FLEX_MAX'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    process.env.CLIENT_ID = 'from-env';
    fs.writeFileSync(path.join(base, '.env'), 'COORDINATION_CHANNEL_ID=from-dotenv\nAUTO_EVENT_SHAI_MAX=4\n');
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({
      CLIENT_ID: 'from-legacy', AUTO_EVENT_CHANNEL_ID: 'from-legacy', COORDINATION_CHANNEL_ID: 'from-legacy',
      AUTO_EVENT_TITLE: 'Legacy title', AUTO_EVENT_SHAI_MAX: '9', AUTO_EVENT_FLEX_MAX: '6',
    }));
    const { legacySettings } = loadEnvironment({ baseDir: base, baked: { CLIENT_ID: 'from-baked', AUTO_EVENT_FLEX_MAX: '7' } });
    assert.equal(process.env.CLIENT_ID, 'from-env');
    assert.equal(process.env.COORDINATION_CHANNEL_ID, 'from-dotenv');
    assert.equal(process.env.AUTO_EVENT_CHANNEL_ID, 'from-legacy');
    // Only legacy editable keys not already supplied by a higher level migrate.
    assert.deepEqual(legacySettings, { AUTO_EVENT_TITLE: 'Legacy title' });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('data dir: override, packaged and dev locations', () => {
  assert.equal(resolveDataDir({ BDO_DATA_DIR: 'C:\\x' }, true), path.resolve('C:\\x'));
  assert.equal(resolveDataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, true), path.join('C:\\Users\\u\\AppData\\Local', 'BDO Balenciaga'));
  assert.ok(resolveDataDir({}, false).endsWith('.data'));
});

test('data dir: pre-rename "BDO Raid Helper" folder is moved to the new name', () => {
  const local = tmp();
  fs.mkdirSync(path.join(local, 'BDO Raid Helper'));
  fs.writeFileSync(path.join(local, 'BDO Raid Helper', 'settings.json'), '{}');
  const dir = resolveDataDir({ LOCALAPPDATA: local }, true);
  assert.equal(dir, path.join(local, 'BDO Balenciaga'));
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  assert.ok(!fs.existsSync(path.join(local, 'BDO Raid Helper')));
});
