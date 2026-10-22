// 部署配置的纯校验；不访问协议端目录，不修改用户配置。
import path from 'node:path';
import net from 'node:net';

function invalid(field, rule) {
  const error = new Error(`配置 ${field} ${rule}`);
  error.status = 400;
  error.expose = true;
  throw error;
}

export function isExternal(config) {
  return config.snowluma?.mode === 'external';
}

export function protocolCapabilities(config) {
  const local = !isExternal(config);
  return { localProcessControl: local, desktopActions: local && process.platform === 'win32', tokenDiscovery: local };
}

export function effectiveServerConfig(config, env = process.env) {
  const host = env.QQ_AGENT_HOST ?? config.server?.host ?? '127.0.0.1';
  const rawPort = env.QQ_AGENT_PORT ?? config.server?.port ?? 3210;
  const port = Number(rawPort);
  if (typeof host !== 'string' || (!net.isIP(host) && !/^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host))) {
    invalid('server.host / QQ_AGENT_HOST', '必须为有效的主机名或 IP 地址');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('server.port / QQ_AGENT_PORT', '必须为 1–65535 的整数');
  return { host, port };
}

export function validateDeploymentConfig(config) {
  if (!['local', 'external'].includes(config.snowluma?.mode ?? 'local')) invalid('snowluma.mode', '必须为 local 或 external');
  for (const [field, protocols] of [['wsUrl', ['ws:', 'wss:']], ['httpUrl', ['http:', 'https:']]]) {
    let url;
    try { url = new URL(config.snowluma?.[field]); } catch { invalid(`snowluma.${field}`, '必须为有效的服务 URL'); }
    if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      invalid(`snowluma.${field}`, '协议不正确，或包含不支持的用户信息/片段');
    }
  }
  // 磁盘值也要校验；环境覆盖单独校验，不参与持久化。
  effectiveServerConfig(config, {});
  if (!['auto', 'base64'].includes(config.media?.sendLocalMode ?? 'auto')) invalid('media.sendLocalMode', '必须为 auto 或 base64');
  const mappings = config.media?.pathMappings ?? [];
  if (!Array.isArray(mappings)) invalid('media.pathMappings', '必须为数组');
  for (const entry of mappings) {
    for (const key of ['remote', 'local']) {
      const root = entry?.[key];
      const style = typeof root === 'string' && /^[a-z]:[\\/]/i.test(root) ? path.win32 : path.posix;
      if (typeof root !== 'string' || root.includes('\0') || !style.isAbsolute(root)
          || style.normalize(root) === style.parse(root).root || root.split(/[\\/]/).includes('..')) {
        invalid(`media.pathMappings.${key}`, '必须为非文件系统根目录的绝对路径，且不得含 ..');
      }
    }
  }
  return config;
}

export function redactConnectionText(value, secrets = []) {
  let text = String(value ?? '');
  text = text.replace(/([?&](?:access_token|token|api_key|key|authorization)=)[^\s&#]*/gi, '$1[REDACTED]');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(String(secret)).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return text;
}
