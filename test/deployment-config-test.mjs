import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveServerConfig, validateDeploymentConfig, redactConnectionText } from '../src/deployment-config.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-config-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  const { DEFAULT_CONFIG, getConfig, updateConfig, loadConfig } = await import('../src/config.js');
  assert.equal(getConfig().snowluma.mode, 'local');
  assert.deepEqual(effectiveServerConfig(DEFAULT_CONFIG, {}), { host: '127.0.0.1', port: DEFAULT_CONFIG.server.port });
  assert.deepEqual(effectiveServerConfig(DEFAULT_CONFIG, { QQ_AGENT_HOST: '0.0.0.0', QQ_AGENT_PORT: '4567' }), { host: '0.0.0.0', port: 4567 });
  for (const port of ['0', '-1', '65536', 'abc', '1.5', '']) assert.throws(() => effectiveServerConfig(DEFAULT_CONFIG, { QQ_AGENT_PORT: port }));
  for (const host of ['', 'http://localhost', 'bad host']) assert.throws(() => effectiveServerConfig(DEFAULT_CONFIG, { QQ_AGENT_HOST: host }));
  const good = structuredClone(DEFAULT_CONFIG);
  good.snowluma = { ...good.snowluma, mode: 'external', wsUrl: 'wss://gateway.example/events?key=value', httpUrl: 'https://gateway.example/api?token=value' };
  good.media = { sendLocalMode: 'base64', pathMappings: [{ remote: '/app/data', local: '/mnt/snowluma/data' }] };
  validateDeploymentConfig(good);
  for (const patch of [
    { snowluma: { mode: 'other' } }, { snowluma: { wsUrl: 'https://gateway.example' } },
    { snowluma: { httpUrl: 'file:///etc/passwd' } }, { snowluma: { httpUrl: 'http://user:pass@localhost' } },
    { server: { host: '' } }, { server: { port: 65536 } }, { media: { sendLocalMode: 'file' } },
    { media: { pathMappings: {} } }, { media: { pathMappings: [{ remote: '/', local: '/mnt/data' }] } },
    { media: { pathMappings: [{ remote: '/app/data', local: 'relative' }] } },
    { media: { pathMappings: [{ remote: '/app/../data', local: '/mnt/data' }] } },
    { media: { pathMappings: [{ remote: 'C:\\', local: '/mnt/data' }] } }
  ]) {
    const before = structuredClone(getConfig());
    assert.throws(() => updateConfig(patch));
    assert.deepEqual(getConfig(), before, '非法更新不得改变内存配置');
  }
  process.env.QQ_AGENT_HOST = '0.0.0.0';
  process.env.QQ_AGENT_PORT = '4567';
  updateConfig({ server: { host: '127.0.0.1', port: 3211 }, snowluma: good.snowluma });
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
  assert.equal(disk.server.port, 3211);
  assert.equal(disk.server.host, '127.0.0.1');
  assert.equal(effectiveServerConfig(getConfig()).port, 4567);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ snowluma: { mode: 'invalid' } }));
  assert.throws(loadConfig, /snowluma.mode/);
  assert.equal(fs.readdirSync(dir).filter(n => n.includes('corrupt')).length, 0, '语义错误不得改名用户文件');
  const safe = redactConnectionText('wss://a/e?access_token=sensitive&token=other raw sensitive', ['sensitive']);
  assert.ok(!safe.includes('sensitive') && !safe.includes('other'));
  console.log('部署配置：兼容默认值、校验、环境优先级、不回写覆盖、非法更新原子性通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
