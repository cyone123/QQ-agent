import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp, waitFor } from './_harness.mjs';

const ctx = await bootApp({ config: { snowluma: { mode: 'external' }, extensions: { hotReload: false } },
  script: [{ delayMs: 8000, toolCalls: [{ name: 'send_message', args: { messages: ['不应发送'] } }] }] });
try {
  ctx.pushGroupMsg(111, '测试', '@覆盖Bot 停机中断模型请求', 88001);
  await waitFor(() => ctx.llm.state.requests.length > 0, 5000, '进入模型请求');
  const sessionId = [...ctx.app.orchestrator.activeRuns.values()][0];
  assert.ok(sessionId);
  const startedAt = Date.now();
  await ctx.app.stop();
  assert.ok(Date.now() - startedAt < 3000, '停机应中断模型，无需等 8 秒响应');
  assert.equal(ctx.app.sessions.get(sessionId).status, 'aborted');
  assert.equal(ctx.app.orchestrator.runningChats.size, 0);
  const index = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'session-index-cache.json')));
  assert.ok(JSON.stringify(index).includes(sessionId));
  await assert.rejects(() => ctx.app.onebot.call('send_group_msg', {}), /已关闭/);
  console.log('运行中停机：中断模型请求、会话 aborted 落盘、阻止停机后继续发送通过');
} finally { await ctx.teardown(); }
process.exit(0);
