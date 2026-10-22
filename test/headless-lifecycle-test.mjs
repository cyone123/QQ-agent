import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort, waitFor } from './_harness.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-lifecycle-'));
const children = new Set();
const rootSource = fileURLToPath(new URL('../', import.meta.url));
const signalShim = process.platform === 'win32';
function boot(dir) {
  const env = { ...process.env, QQ_AGENT_DATA_DIR: dir, QQ_AGENT_HOST: '127.0.0.1' };
  delete env.QQ_AGENT_PORT;
  const child = fork(signalShim ? path.join(rootSource, 'test/fixtures/headless-signal-child.mjs') : path.join(rootSource, 'src/server.js'), [], {
    cwd: rootSource, silent: true, execArgv: [],
    env
  });
  // PORT 不设置才沿用磁盘值（空字符串属于非法显式覆盖）。
  children.add(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    children.delete(child); resolve({ code, signal, output });
  }));
  return { child, exited, output: () => output };
}
function writeConfig(dir, port, mode = 'external') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    server: { port }, snowluma: { mode, dir: path.join(dir, 'no-snowluma'), autoLaunch: false,
      wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' }, extensions: { hotReload: false }
  }));
}
async function boundedExit(run) {
  let timer;
  try { return await Promise.race([run.exited, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`子进程退出超时\n${run.output()}`)), 12000);
  })]); } finally { clearTimeout(timer); }
}
try {
  // 用 env 删除语义启动真实子进程，不使用本机用户配置。
  delete process.env.QQ_AGENT_PORT;
  const configDir = path.join(root, 'data');
  const port = await freePort();
  writeConfig(configDir, port);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const run = boot(configDir);
    await waitFor(async () => {
      if (run.child.exitCode != null) throw new Error(run.output());
      try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { return false; }
    }, 8000, 'headless 启动');
    await waitFor(() => run.output().includes('控制台已就绪'), 5000, '启动完成');
    const started = Date.now();
    if (signalShim) run.child.send(signal); else run.child.kill(signal);
    const result = await boundedExit(run);
    assert.equal(result.code, 0, result.output);
    assert.ok(Date.now() - started < 12000);
    assert.equal(fs.existsSync(path.join(configDir, 'qq-agent.lock')), false);
    assert.ok(fs.existsSync(path.join(configDir, 'session-index-cache.json')));
    assert.ok(fs.readdirSync(path.join(configDir, 'logs')).length > 0);
  }
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(port, '127.0.0.1', resolve));
  try {
    const run = boot(configDir);
    const result = await boundedExit(run);
    assert.equal(result.code, 1, 'external 端口占用必须失败退出');
    assert.match(result.output, /EADDRINUSE/);
    assert.equal(fs.existsSync(path.join(configDir, 'qq-agent.lock')), false);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
  console.log(`Headless 生命周期：${signalShim ? 'Windows IPC 分发信号事件（POSIX 原生信号待 Linux 验收）' : 'POSIX SIGTERM/SIGINT'}、正常退出、日志/索引落盘、重启拿锁、端口占用失败通过`);
} finally {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
}
