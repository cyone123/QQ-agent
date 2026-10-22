import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { freePort, waitFor, sleep } from './_harness.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-external-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.QQ_AGENT_HOST = '0.0.0.0';
process.env.QQ_AGENT_PORT = String(await freePort());
const trap = path.join(dir, 'local-snowluma');
fs.mkdirSync(path.join(trap, 'config'), { recursive: true });
fs.writeFileSync(path.join(trap, 'config', 'onebot_123.json'), JSON.stringify({ networks: { wsServers: [{ port: 3001, accessToken: 'local-secret' }] } }));
const protocolPort = await freePort();
const endpoint = `127.0.0.1:${protocolPort}`;
const persistedPort = await freePort();
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  snowluma: { mode: 'external', dir: trap, autoLaunch: true, wsUrl: `ws://${endpoint}/events?route=qq`,
    httpUrl: `http://${endpoint}/proxy/onebot?route=qq`, accessToken: 'ws-secret', httpAccessToken: '' },
  server: { host: '127.0.0.1', port: persistedPort, token: 'console-secret' },
  extensions: { hotReload: false }, proactive: { enabled: false }, allow: { groups: ['456'], private: [] }
}));
let localReads = 0;
const originalRead = fs.readFileSync;
const originalReaddir = fs.readdirSync;
for (const [name, original] of [['readFileSync', originalRead], ['readdirSync', originalReaddir]]) {
  fs[name] = function (file, ...args) {
    if (String(file).startsWith(trap)) localReads++;
    return original.call(this, file, ...args);
  };
}
let expectedWs = 'ws-secret';
let expectedHttp = 'ws-secret';
let httpCalls = 0;
let deniedUpgrades = 0;
let account = '888';
const seenAuth = [];
const protocol = http.createServer(async (req, res) => {
  httpCalls++;
  seenAuth.push(req.headers.authorization);
  if (req.headers.authorization !== `Bearer ${expectedHttp}`) { res.writeHead(401); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  assert.equal(url.searchParams.get('route'), 'qq');
  const action = url.pathname.replace('/proxy/onebot/', '');
  const data = action === 'get_version_info' ? { app_name: 'mock', app_version: '1' }
    : action === 'get_login_info' ? { user_id: Number(account), nickname: '测试账号' } : {};
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
});
const wss = new WebSocketServer({ noServer: true });
protocol.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/events' || url.searchParams.get('access_token') !== expectedWs || req.headers.authorization !== `Bearer ${expectedWs}`) {
    deniedUpgrades++;
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
const logs = [];
let app;
try {
  const { OneBotClient } = await import('../src/onebot.js');
  const diagnosticClient = new OneBotClient({});
  for (const [error, expected] of [['connect ECONNREFUSED 127.0.0.1:40100', /拒绝连接/],
    ['getaddrinfo ENOTFOUND snowluma', /域名解析失败/], ['请求超时', /超时/],
    ['Unexpected server response: 401', /鉴权失败/]]) {
    diagnosticClient.lastConnectError = error;
    assert.match(diagnosticClient.diagnosis(), expected);
  }
  const { createApp } = await import('../src/app.js');
  app = createApp({ log: (...args) => logs.push(args.join(' ')) });
  const port = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const request = async (route, body, extraHeaders = {}) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'console-secret', 'content-type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal(app.server.address().address, '0.0.0.0');
  assert.equal(port, Number(process.env.QQ_AGENT_PORT));
  assert.equal((await fetch(base + '/healthz')).status, 200, '离线时存活端点无需令牌');
  assert.equal((await fetch(base + '/')).status, 200, '离线时仍能打开控制台');
  let status = (await request('/api/status')).data;
  assert.equal(status.onebot.connected, false);
  assert.equal(status.snowluma.running, null);
  assert.equal(status.capabilities.localProcessControl, false);
  assert.equal(status.server.listening.host, '0.0.0.0');
  assert.equal(status.qqPortable.supported, false);
  for (const route of ['/api/open-data-dir', '/api/snowluma/launch', '/api/snowluma/stop',
    '/api/snowluma/open-folder', '/api/snowluma/open-webui', '/api/qq-portable/launch', '/api/qq-portable/stop']) {
    assert.equal((await request(route, {})).status, 409, route);
  }
  for (const fn of ['launchSnowluma', 'stopSnowluma', 'launchPortableQQ', 'stopPortableQQ']) assert.equal((await app[fn]()).ok, false);
  assert.equal((await request('/api/config', { snowluma: { mode: 'bad' } })).status, 400);
  assert.equal((await request('/api/status', undefined, { origin: 'https://evil.example' })).status, 403);
  await new Promise(resolve => protocol.listen(protocolPort, '127.0.0.1', resolve));
  await waitFor(() => app.onebot.selfId === '888', 8000, '离线启动后自动恢复');
  const beforeStatus = httpCalls;
  await Promise.all(Array.from({ length: 5 }, () => request('/api/status')));
  assert.equal(httpCalls, beforeStatus, '状态轮询不得发 HTTP 探测');
  const tests = await Promise.all([request('/api/onebot/test-connection', {}), request('/api/onebot/test-connection', {})]);
  assert.equal(tests[0].data.ok, true);
  assert.equal(httpCalls - beforeStatus, 2, '并发测试连接复用同一组检查');
  await request('/api/onebot/test-connection', {});
  assert.equal(httpCalls - beforeStatus, 2, '短期结果缓存');
  assert.ok(seenAuth.every(auth => auth === 'Bearer ws-secret'), 'HTTP 空令牌沿用 WS 令牌');
  const ws = [...wss.clients][0];
  ws.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 999, user_id: 111,
    self_id: 888, message_id: 22, time: Math.floor(Date.now()/1000), message: [{ type: 'text', data: { text: '不在白名单' } }], sender: { nickname: '测试' } }));
  await sleep(100);
  assert.equal(app.store.recent('group:999', { limit: 10 }).length, 0);
  ws.terminate();
  await waitFor(() => !app.onebot.connected, 1000, '断线状态');
  await waitFor(() => app.onebot.selfId === '888', 6000, '断线重连');
  await request('/api/config', { snowluma: { accessToken: 'wrong-secret' } });
  await waitFor(() => deniedUpgrades > 0 && app.onebot.lastConnectError.includes('401'), 2000, '错误令牌明确报错');
  status = (await request('/api/status')).data;
  assert.match(status.onebot.diagnosis, /鉴权失败/);
  assert.equal(app.getConfig().snowluma.accessToken, 'wrong-secret');
  assert.equal(app.onebot.tokenCandidates.length, 0);
  await request('/api/config', { snowluma: { accessToken: expectedWs, httpAccessToken: 'wrong-http-secret' } });
  await waitFor(() => app.onebot.connected && app.onebot.httpStatus.error.includes('401'), 2000, 'HTTP 与 WS 鉴权分开诊断');
  status = (await request('/api/status')).data;
  assert.equal(status.onebot.connected, true);
  assert.equal(status.onebot.self, null);
  const failedHttpTest = (await request('/api/onebot/test-connection', {})).data;
  assert.equal(failedHttpTest.ok, false);
  assert.match(failedHttpTest.version.error, /401/);
  expectedWs = 'new-ws-secret'; expectedHttp = 'new-http-secret'; account = '889';
  await request('/api/config', { snowluma: { accessToken: expectedWs, httpAccessToken: expectedHttp }, server: { port: persistedPort } });
  await waitFor(() => app.onebot.selfId === '889', 2000, '更新连接配置立即生效');
  await sleep(3300);
  assert.equal(wss.clients.size, 1, '配置变化后只保留一个连接');
  assert.equal(localReads, 0, 'autoLaunch=true 且本地配置存在时仍不读本地目录');
  await request('/api/config', { snowluma: { mode: 'local', autoLaunch: false } });
  await waitFor(() => app.onebot.selfId === '889', 2000, '切回本地模式');
  assert.ok(localReads > 0, '本地模式仍能扫描本地令牌候选');
  await request('/api/config', { snowluma: { mode: 'external', autoLaunch: true } });
  const readsAfterSwitch = localReads;
  await waitFor(() => app.onebot.selfId === '889', 2000, '再次切换外部模式');
  await sleep(3300);
  assert.equal(localReads, readsAfterSwitch, '旧本地轮询不得在切换后继续扫描');
  assert.equal(wss.clients.size, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).server.host, '127.0.0.1');
  const privateText = logs.join('\n') + JSON.stringify((await request('/api/status')).data);
  for (const secret of ['ws-secret', 'wrong-secret', 'wrong-http-secret', 'new-ws-secret', 'new-http-secret', 'local-secret']) assert.ok(!privateText.includes(secret));
  // HTTP/SSE 应正常收尾，重复 stop 返回同一个 Promise。
  const sse = await fetch(base + '/api/events', { headers: { 'x-console-token': 'console-secret' } });
  const reader = sse.body.getReader();
  await reader.read();
  const session = app.sessions.create({ chatKey: 'group:456', trigger: 'shutdown-test' });
  app.sessions.finish(session.id, 'done');
  const stopped = app.stop();
  assert.equal(app.stop(), stopped);
  await stopped;
  while (!(await reader.read()).done) { /* drain */ }
  assert.equal(fs.existsSync(path.join(dir, 'qq-agent.lock')), false);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'session-index-cache.json')));
  assert.ok(JSON.stringify(index).includes(session.id), '最后一条会话索引已落盘');
  assert.ok(fs.readdirSync(path.join(dir, 'logs')).length > 0, '停机日志已刷新');
  assert.equal(protocol.listening, true, 'Agent 停止不关闭外部协议端');
  console.log('外部 OneBot：离线控制台、能力限制、鉴权、HTTP 路径、诊断缓存、断线恢复、单连接切换、SSE 停机通过');
} finally {
  if (app) await app.stop();
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => wss.close(resolve));
  if (protocol.listening) await new Promise(resolve => protocol.close(resolve));
  fs.readFileSync = originalRead;
  fs.readdirSync = originalReaddir;
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
