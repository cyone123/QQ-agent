// Run as the image's non-root user against an initialized, writable data volume.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { validateDeploymentConfig } from '../src/deployment-config.js';

const root = process.env.QQ_AGENT_DATA_DIR;
if (!root || !path.isAbsolute(root)) throw new Error('QQ_AGENT_DATA_DIR must be absolute');
const dest = path.join(root, 'config.json');
const source = process.argv[2] || fileURLToPath(new URL('./config.linux.example.json', import.meta.url));
const input = JSON.parse(fs.readFileSync(source, 'utf8'));
const config = validateDeploymentConfig(deepMerge(DEFAULT_CONFIG, input));
if (config.snowluma.mode !== 'external') throw new Error('Linux initializer requires external mode');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
// Exclusive creation: repeated execution never replaces a live config or credentials.
fs.writeFileSync(dest, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created external-mode config. Set OneBot token, model and allowlist through the SSH console.');
