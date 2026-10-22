// Windows 的 child.kill(SIGTERM) 是强制结束；测试用 IPC 分发进程信号事件，
// 仍加载真实 headless 入口，覆盖真实 handler 与 app.stop，而不假装是 POSIX 信号。
process.on('message', signal => {
  if (signal === 'SIGTERM' || signal === 'SIGINT') process.emit(signal);
});
await import('../../src/server.js');
