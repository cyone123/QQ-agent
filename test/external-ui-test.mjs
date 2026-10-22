import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="snowluma-page"></div><form id="settings-form"></form>', { url: 'http://127.0.0.1:3210/' });
const document = dom.window.document;
const requests = [];
const status = { snowluma: { mode: 'external' }, capabilities: { desktopActions: false }, server: { listening: { host: '0.0.0.0', port: 3210 } }, onebot: { connected: false, http: { available: null }, self: null, diagnosis: '后台将自动重试', endpoints: { ws: 'ws://snowluma:3001', http: 'http://snowluma:3000' } } };
const config = { snowluma: { mode: 'external', wsUrl: 'ws://snowluma:3001', httpUrl: 'http://snowluma:3000' }, media: { sendLocalMode: 'base64', pathMappings: [{ remote: '/app/data', local: '/mnt/data' }] }, api: { baseUrl: 'https://example.com', model: 'mock' }, allow: { groups: ['1'], private: [] }, server: { host: '0.0.0.0', port: 3210 } };
const context = vm.createContext({
  document, console, setTimeout, clearTimeout, structuredClone, Event: dom.window.Event,
  $: s => document.querySelector(s), $$: s => [...document.querySelectorAll(s)],
  state: { status, config, settingsSection: 'onebot' },
  esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  fmtTime: t => String(t), refreshStatus() {}, switchTab(tab) { context.activeTab = tab; },
  api: async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/status') return status;
    if (url.startsWith('/api/logs')) return { logs: [] };
    if (url === '/api/onebot/test-connection') return { ok: false, checkedAt: 123, wsConnected: false, version: { ok: true }, login: { ok: false, error: 'HTTP 401' } };
    if (url === '/api/config') return { config: { ...config, ...JSON.parse(options.body) } };
    throw new Error('Unexpected endpoint: ' + url);
  }
});
for (const name of ['03-snowluma', '06-settings-render', '08-modals']) vm.runInContext(fs.readFileSync(`ui/app/${name}.js`, 'utf8'), context);
const core = fs.readFileSync('ui/app/00-core.js', 'utf8');
vm.runInContext(core.slice(core.indexOf('function assessReadiness('), core.indexOf('function renderBanner(')), context);
await vm.runInContext('loadSnowlumaPage()', context);
assert.match(document.body.textContent, /外部 OneBot/);
assert.equal(document.querySelector('#quick-start-btn'), null);
assert.equal(document.querySelector('#sl-start-btn'), null);
assert.equal(document.querySelector('#qq-start-btn'), null);
assert.equal(requests.some(r => /snowluma\/|qq-portable/.test(r.url)), false);
document.querySelector('#external-test-btn').click();
await new Promise(resolve => setTimeout(resolve, 10));
assert.match(document.querySelector('#external-test-result').textContent, /HTTP 401/);
assert.equal(requests.filter(r => r.url === '/api/onebot/test-connection').length, 1);
document.querySelector('#external-settings-btn').click();
assert.equal(context.activeTab, 'settings');
assert.equal(context.state.settingsSection, 'onebot');
document.querySelector('#settings-form').innerHTML = vm.runInContext('renderOnebotSection(state.config)', context);
assert.equal(document.querySelector('#onebot-local-settings').hidden, true);
assert.equal(document.querySelector('#open-snowluma-btn'), null);
document.querySelector('#cfg-wsurl').value = 'wss://new.example/onebot';
document.querySelector('#cfg-obtoken').value = 'new-token';
document.querySelector('#cfg-media-mappings').value = '[{"remote":"/app/data","local":"/mnt/new"}]';
await vm.runInContext('saveConfig({quiet:true})', context);
const patch = JSON.parse(requests.at(-1).options.body);
assert.equal(patch.snowluma.mode, 'external');
assert.equal(patch.snowluma.wsUrl, 'wss://new.example/onebot');
assert.equal(patch.snowluma.accessToken, 'new-token');
assert.equal(patch.media.pathMappings[0].local, '/mnt/new');
assert.equal(patch.server.port, 3210);
document.querySelector('#cfg-obtoken').value = '';
document.querySelector('#cfg-obtoken').dataset.clearToken = 'true';
document.querySelector('#cfg-obhttptoken').value = '******';
await vm.runInContext('saveConfig({quiet:true})', context);
const cleared = JSON.parse(requests.at(-1).options.body);
assert.equal(cleared.snowluma.accessToken, '');
assert.equal(Object.hasOwn(cleared.snowluma, 'httpAccessToken'), false, 'masked independent token is preserved');
document.querySelector('#cfg-media-mappings').value = 'invalid-json';
const count = requests.length;
await assert.rejects(vm.runInContext('saveConfig({quiet:true})', context));
assert.equal(requests.length, count, 'bad mappings do not reach persistence');
const ready = vm.runInContext('assessReadiness(state.config, state.status)', context);
assert.equal(ready.ready, false);
assert.ok(!ready.checks.at(-1).label.includes('启动 QQ'));
console.log('External UI: offline, no local endpoints/actions, connection test and settings persistence passed');
dom.window.close();
