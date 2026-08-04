#!/usr/bin/env node
/**
 * Cross-platform `npm run dev` entry (Mac/Linux/Windows).
 * Preloads NODE_EXTRA_CA_CERTS / LOAD_TEST_DNS_SERVERS from .env
 * before Node starts (same as scripts/dev.ps1 + load-dev-env.ps1).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const envFile = path.join(backendRoot, '.env');
const preloadKeys = new Set(['NODE_EXTRA_CA_CERTS', 'LOAD_TEST_DNS_SERVERS']);

if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!preloadKeys.has(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

const tsxCli = path.join(backendRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsxCli, 'watch', 'src/server.ts'], {
  cwd: backendRoot,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
