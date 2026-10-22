// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
// 未捕获异常后进程处于未定义状态（定时器丢失/连接悬空），记录后退出，
// 交给外层（systemd/脚本守护）重启 —— 只打印不退出会"半死不活"地挂着
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

const app = createApp();
let shutdownPromise = null;
function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  console.log('退出中…');
  // 小于实例锁的 30 秒保险丝，也为 Docker 的 40 秒宽限留出余量。
  const deadline = setTimeout(() => {
    console.error('[退出超时] 25 秒内未完成清理');
    process.exit(1);
  }, 25000);
  shutdownPromise = app.stop().then(() => {
    clearTimeout(deadline);
    process.exit(exitCode);
  }, error => {
    console.error('[退出失败]', error);
    process.exit(1);
  });
  return shutdownPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown());
app.start().catch(error => {
  console.error('[启动失败]', error);
  shutdown(1);
});
