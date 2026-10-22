import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-send-media-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { updateConfig } = await import('../src/config.js');
const { SendQueue } = await import('../src/sender.js');
const { MAX_IMAGE_BYTES } = await import('../src/media-paths.js');
updateConfig({ snowluma: { mode: 'external' }, media: { sendLocalMode: 'base64' } });
const image = path.join(root, 'image.png');
fs.writeFileSync(image, 'image-bytes');
const sticker = path.join(root, 'sticker-images', 's.png');
fs.mkdirSync(path.dirname(sticker)); fs.copyFileSync(image, sticker);
const calls = [], archives = [];
let fail = false;
const send = async (...args) => { calls.push(args); if (fail) throw new Error('mock failure'); return { message_id: calls.length }; };
const onebot = { sendImage: send, sendSticker: send, sendSegments: send, call: async () => ({ file: '/remote/image.png' }) };
const queue = new SendQueue({ onebot, store: { appendSelf: (...args) => archives.push(args) } });
try {
  await queue.sendImage('group:1', { file: image });
  assert.equal(calls[0][2], 'base64://' + Buffer.from('image-bytes').toString('base64'));
  await assert.rejects(queue.sendImage('group:1', { file: image }), /刚刚发过/);
  assert.equal(calls.length, 1);
  await queue.sendSticker('group:1', { id: 's', url: pathToFileURL(sticker).href });
  assert.ok(calls[1][2].startsWith('base64://'));
  const count = archives.length;
  fail = true;
  await assert.rejects(queue.sendImage('group:2', { file: image }), /mock failure/);
  assert.equal(archives.length, count);
  fail = false;
  await queue.sendImage('group:2', { file: image }); // failed send did not dedupe
  await queue.sendMedia('group:3', [{ type: 'image', data: { file: image } }]);
  assert.ok(calls.at(-1)[2][0].data.file.startsWith('base64://'));
  await assert.rejects(queue.sendMedia('group:4', [{ type: 'video', data: { file: image } }]), /共享出站目录/);
  await queue.sendMedia('group:5', [{ type: 'video', data: { file: 'https://example.com/video.mp4' } }]);
  assert.equal(calls.at(-1)[2][0].data.file, 'https://example.com/video.mp4');
  const before = calls.length;
  const big = path.join(root, 'big.png');
  const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, MAX_IMAGE_BYTES + 1); fs.closeSync(fd);
  await assert.rejects(queue.sendImage('group:6', { file: big }), /15 MiB/);
  await assert.rejects(queue.sendImage('group:7', { file: path.join(root, 'missing') }), /ENOENT/);
  assert.equal(calls.length, before, 'preparation failures never reach OneBot');
  updateConfig({ media: { pathMappings: [{ remote: '/app/cache', local: root }] } });
  const recoveryCalls = [];
  const recovery = new SendQueue({
    store: { appendSelf() {} },
    onebot: {
      call: async () => ({ file: '/app/cache/image.png' }),
      sendSticker: async (_kind, _id, ref) => {
        recoveryCalls.push(ref);
        if (ref.startsWith('https:')) throw new Error('expired URL');
        return { message_id: 10 };
      }
    }
  });
  await recovery.sendSticker('group:9', { id: 'legacy', url: 'https://expired.invalid/image.png' });
  assert.equal(recoveryCalls.length, 2);
  assert.ok(recoveryCalls[1].startsWith('base64://'), 'protocol cache recovery must apply mappings and Base64');
  updateConfig({ media: { sendLocalMode: 'auto' }, snowluma: { mode: 'local' } });
  await queue.sendImage('group:8', { file: image });
  assert.ok(calls.at(-1)[2].startsWith('file:///'));
  console.log('Media send: Base64 image/sticker/multi-image, dedupe, failure retry, size, local compatibility passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
