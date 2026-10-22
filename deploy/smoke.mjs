// Requires a running Linux Docker Engine. Uses only disposable Agent resources, no QQ volumes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const image = process.argv[2] || 'qq-agent:linux-p3-p5';
const id = `qqa-smoke-${process.pid}-${Date.now()}`;
const volume = `${id}-data`;
function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) throw new Error(`docker ${args[0]}: ${r.error?.message || r.stderr}`);
  return r.stdout.trim();
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function healthy() {
  const port = JSON.parse(docker('inspect', id))[0].NetworkSettings.Ports['3210/tcp'][0].HostPort;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* starting */ }
    await delay(500);
  }
  throw new Error('Agent did not become healthy');
}
try {
  assert.equal(docker('info', '--format', '{{.OSType}}'), 'linux');
  docker('volume', 'create', volume);
  docker('run', '--rm', '--network', 'none', '--mount', `type=volume,src=${volume},dst=/var/lib/qq-agent`, image, 'node', 'deploy/init-data.mjs');
  docker('run', '-d', '--name', id, '--init', '--network', 'bridge', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '-p', '127.0.0.1::3210', '--mount', `type=volume,src=${volume},dst=/var/lib/qq-agent`, image);
  await healthy();
  docker('exec', id, 'node', '--input-type=module', '-e', `
    import fs from 'node:fs';
    if(process.getuid()===0) throw Error('root runtime');
    for(const p of ['electron','jsdom','electron-builder']) if(fs.existsSync('node_modules/'+p)) throw Error('dev dependency: '+p);
    const r=await fetch('http://127.0.0.1:3210/api/status',{headers:{'x-console-token':'qq-agent-console'}});
    if(!r.ok || (await r.json()).snowluma.mode!=='external') throw Error('external status');
    fs.writeFileSync('/var/lib/qq-agent/smoke-persist','persisted');
    console.log('Non-root runtime, offline health and external status OK');
  `);
  docker('exec', id, 'ffmpeg', '-version');
  docker('exec', id, 'ffprobe', '-version');
  docker('stop', '-t', '40', id);
  let state = JSON.parse(docker('inspect', id))[0].State;
  assert.equal(state.ExitCode, 0, 'SIGTERM exits cleanly');
  docker('start', id);
  await healthy();
  docker('exec', id, 'node', '-e', "if(require('fs').readFileSync('/var/lib/qq-agent/smoke-persist','utf8')!=='persisted')process.exit(1)");
  docker('stop', '-t', '40', id);
  state = JSON.parse(docker('inspect', id))[0].State;
  assert.equal(state.ExitCode, 0);
  console.log('Linux container smoke passed: non-root, production deps, ffmpeg, offline console, SIGTERM, restart and volume persistence.');
} finally {
  // Only the exact randomly named resources created above are removed.
  spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore', timeout: 60000 });
  spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore', timeout: 60000 });
}
