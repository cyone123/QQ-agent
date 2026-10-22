// Protocol paths are untrusted. This module only resolves reads; never write through a mapping.
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const windowsPath = (s) => /^[A-Za-z]:[\\/]/.test(s);
const pathApi = (s) => windowsPath(s) ? path.win32 : path.posix;
const inside = (api, root, file) => {
  const rel = api.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
};

export function mediaReference(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.includes('\0')) return { kind: 'invalid' };
  if (/^https?:\/\//i.test(value)) return { kind: 'url', value };
  if (/^(base64:\/\/|data:)/i.test(value)) return { kind: 'inline', value };
  let file = value;
  if (/^file:/i.test(value)) {
    try {
      if (!/^file:\/\/\//i.test(value)) return { kind: 'invalid' };
      // Check before URL normalization, which would silently remove dot segments.
      const decoded = decodeURIComponent(value.slice(5));
      if (decoded.includes('\0') || decoded.split(/[\\/]/).includes('..')) return { kind: 'invalid' };
      const uri = new URL(value);
      if (uri.hostname || uri.search || uri.hash) return { kind: 'invalid' };
      file = decodeURIComponent(uri.pathname);
      if (/^\/[A-Za-z]:\//.test(file)) file = file.slice(1);
    } catch { return { kind: 'invalid' }; }
  }
  if (file.split(/[\\/]/).includes('..')) return { kind: 'invalid' };
  const api = pathApi(file);
  if (!api.isAbsolute(file) || file.startsWith('\\\\') || file.startsWith('//')) return { kind: 'id', value };
  return { kind: 'path', value: api.normalize(file), api };
}

/** Returns a distinguishable reason on failure so callers can fall back to a safe URL. */
export function resolveMediaPath(raw, config = getConfig()) {
  const ref = mediaReference(raw);
  if (ref.kind !== 'path') return { ok: false, reason: ref.kind === 'invalid' ? 'INVALID_PATH' : 'NOT_PATH' };
  let candidate = ref.value;
  let root;
  if (config.snowluma?.mode === 'external') {
    const mappings = [...(config.media?.pathMappings || [])].sort((a, b) => b.remote.length - a.remote.length);
    const match = mappings.find((m) => inside(ref.api, ref.api.normalize(m.remote), ref.value));
    if (!match) return { ok: false, reason: 'UNMAPPED_PATH' };
    root = path.resolve(match.local);
    candidate = path.resolve(root, ...ref.api.relative(ref.api.normalize(match.remote), ref.value).split(/[\\/]/));
    if (!inside(path, root, candidate)) return { ok: false, reason: 'OUTSIDE_ROOT' };
  }
  try {
    const real = fs.realpathSync(candidate);
    if (root && !inside(path, fs.realpathSync(root), real)) return { ok: false, reason: 'SYMLINK_ESCAPE' };
    if (!fs.statSync(real).isFile()) return { ok: false, reason: 'NOT_FILE' };
    fs.accessSync(real, fs.constants.R_OK);
    return { ok: true, path: real };
  } catch (error) {
    return { ok: false, reason: error.code === 'EACCES' || error.code === 'EPERM' ? 'UNREADABLE' : error.code === 'ENOENT' ? 'NOT_FOUND' : 'IO_ERROR' };
  }
}

/** Bound the actual read too, in case a file grows after stat. */
export function readImageFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !stat.size) throw new Error('图片不是非空文件');
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 15 MiB 上限');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size !== stat.size) throw new Error('读取期间图片大小改变，请重试');
    return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

export function imageBase64(file) {
  return `base64://${readImageFile(file).toString('base64')}`;
}

export function boundedInlineImage(ref) {
  const value = String(ref);
  const body = value.startsWith('base64://') ? value.slice(9) : value.match(/^data:image\/[\w.+-]+;base64,(.*)$/s)?.[1];
  if (body === undefined || !body || body.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body) || Buffer.byteLength(body, 'base64') > MAX_IMAGE_BYTES) {
    throw new Error('图片 Base64 无效或超过 15 MiB 上限');
  }
  return `base64://${body}`;
}
