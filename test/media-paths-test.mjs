import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-media-'));
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'agent');
const { resolveMediaPath, mediaReference, readImageFile, MAX_IMAGE_BYTES } = await import('../src/media-paths.js');
const { updateConfig } = await import('../src/config.js');
const { StickerManager } = await import('../src/sticker-manager.js');
const { VideoReader } = await import('../src/video-reader.js');
const mount = path.join(root, 'mount');
const nested = path.join(root, 'nested');
fs.mkdirSync(mount);
fs.mkdirSync(nested);
const file = path.join(mount, '中文 空格#.png');
fs.writeFileSync(file, 'image-bytes');
fs.writeFileSync(path.join(nested, 'test.png'), 'longest');
const config = { snowluma: { mode: 'external' }, media: { pathMappings: [
  { remote: '/app/data', local: mount }, { remote: '/app/data/deep', local: nested }
] } };
const download = http.createServer((_req, res) => { res.setHeader('content-type', 'image/png'); res.end('url-fallback'); });
await new Promise(resolve => download.listen(0, '127.0.0.1', resolve));
try {
  assert.equal(resolveMediaPath('/app/data/中文 空格#.png', config).path, fs.realpathSync(file));
  assert.equal(resolveMediaPath('file:///app/data/' + encodeURIComponent('中文 空格#.png'), config).path, fs.realpathSync(file));
  assert.equal(resolveMediaPath('/app/data/deep/test.png', config).path, fs.realpathSync(path.join(nested, 'test.png')));
  assert.equal(resolveMediaPath('/app/data-other/x', config).reason, 'UNMAPPED_PATH');
  assert.equal(resolveMediaPath(file, config).reason, 'UNMAPPED_PATH');
  for (const raw of ['/app/data/../secret', 'file:///app/data/%2e%2e/secret', 'file://other/app/data/a', 'file:relative', 'file:///app/data/a%00b', '/app/data/a\0b']) {
    assert.equal(resolveMediaPath(raw, config).reason, 'INVALID_PATH', raw);
  }
  assert.equal(resolveMediaPath('/app/data/missing', config).reason, 'NOT_FOUND');
  fs.mkdirSync(path.join(mount, 'dir'));
  assert.equal(resolveMediaPath('/app/data/dir', config).reason, 'NOT_FILE');
  for (const [raw, kind] of [['https://example.com/x', 'url'], ['base64://YQ==', 'inline'], ['ABC.image', 'id']]) assert.equal(mediaReference(raw).kind, kind);
  fs.writeFileSync(path.join(mount, '%2e%2e.png'), 'once');
  assert.equal(resolveMediaPath('file:///app/data/%252e%252e.png', config).ok, true, 'decode once');
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, 'private');
  // Directory junctions work without Windows symlink privileges.
  fs.symlinkSync(root, path.join(mount, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveMediaPath('/app/data/escape/outside.png', config).reason, 'SYMLINK_ESCAPE');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    fs.chmodSync(file, 0);
    assert.equal(resolveMediaPath('/app/data/中文 空格#.png', config).reason, 'UNREADABLE');
    fs.chmodSync(file, 0o600);
  } else console.log('Permission denial: requires non-root POSIX, not asserted on Windows/root');
  assert.equal(resolveMediaPath(file, { snowluma: { mode: 'local' } }).ok, true);
  const winConfig = { snowluma: { mode: 'external' }, media: { pathMappings: [{ remote: 'C:\\qq\\cache', local: mount }] } };
  assert.equal(resolveMediaPath('file:///C:/qq/cache/' + encodeURIComponent('中文 空格#.png'), winConfig).path, fs.realpathSync(file));
  const big = path.join(mount, 'big.png');
  const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, MAX_IMAGE_BYTES + 1); fs.closeSync(fd);
  assert.throws(() => readImageFile(big), /15 MiB/);
  updateConfig({ ...config, api: { videoMode: 'off' } });
  const calls = [];
  const onebot = { call: async action => { calls.push(action); return { file: '/app/data/中文 空格#.png' }; } };
  const manager = new StickerManager(onebot);
  const collected = await manager.collect('123', { file: 'mock-image', url: '', note: 'mapping' });
  assert.ok(collected);
  const reader = new VideoReader(onebot);
  const video = await reader.probe({ path: '/app/data/中文 空格#.png' });
  assert.equal(video.sizeBytes, Buffer.byteLength('image-bytes'));
  assert.equal(video.route, 'meta');
  // Local HTTP fixture allowed only inside this isolated test config; defaults remain restricted.
  updateConfig({ security: { allowPrivateImageHosts: true } });
  const url = `http://127.0.0.1:${download.address().port}/image`;
  const fallbackManager = new StickerManager({ call: async () => ({ file: outside, url }) });
  const saved = await fallbackManager.collect('456', { file: 'cache-id' });
  const { localStickerPath } = await import('../src/sticker-manager.js');
  assert.equal(fs.readFileSync(localStickerPath(saved.url), 'utf8'), 'url-fallback', 'unmapped protocol path must fall back to URL');
  const fallbackVideo = await reader.probe({ path: outside, url });
  assert.equal(fallbackVideo.sizeBytes, Buffer.byteLength('url-fallback'));
  console.log('Media mappings: boundary, longest prefix, URI, symlink, size, collection and video reads passed');
} finally {
  await new Promise(resolve => download.close(resolve));
  fs.rmSync(path.join(mount, 'escape'), { force: true, recursive: true });
  fs.rmSync(root, { recursive: true, force: true });
}
