import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-init-'));
const env = { ...process.env, QQ_AGENT_DATA_DIR: dir };
try {
  const run = () => spawnSync(process.execPath, ['deploy/init-data.mjs'], { env, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(dir, 'config.json');
  const config = JSON.parse(fs.readFileSync(file));
  assert.equal(config.snowluma.mode, 'external');
  assert.equal(config.snowluma.wsUrl, 'ws://snowluma:3001');
  assert.equal(config.media.sendLocalMode, 'base64');
  assert.equal(config.api.baseUrl, '');
  assert.equal(config.allowAllWhenEmpty, false);
  config.snowluma.accessToken = 'test-do-not-overwrite';
  fs.writeFileSync(file, JSON.stringify(config));
  assert.notEqual(run().status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file)).snowluma.accessToken, 'test-do-not-overwrite');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  console.log('Deployment initializer: full defaults, external mode, allowlist closed, no overwrite passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
