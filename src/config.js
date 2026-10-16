'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  INTENTLOCK_MODE: 'OFFLINE_DEMO',
  ADP_ENDPOINT: 'https://wss.lke.tencentcloud.com/adp/v2/chat',
  ADP_VISITOR_ID: 'intentlock-demo-user',
  ADP_TIMEOUT_MS: '15000',
  ADP_MAX_RESPONSE_BYTES: '16384',
  PORT: '8787',
  ALLOW_AUTH_SIMULATOR: 'false',
  INTENTLOCK_DB_PATH: '',
  ALLOW_RISK_SIMULATOR: 'false',
});

function parseDotEnv(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  let fileValues = {};
  const envPath = path.join(cwd, '.env');
  try { fileValues = parseDotEnv(fs.readFileSync(envPath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const raw = { ...DEFAULTS, ...fileValues, ...env };
  const mode = String(raw.INTENTLOCK_MODE).toUpperCase();
  if (!['LIVE', 'OFFLINE_DEMO'].includes(mode)) throw new Error('INTENTLOCK_MODE must be LIVE or OFFLINE_DEMO.');
  const timeoutMs = Number(raw.ADP_TIMEOUT_MS);
  const maxResponseBytes = Number(raw.ADP_MAX_RESPONSE_BYTES);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('ADP_TIMEOUT_MS must be an integer from 1000 to 120000.');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 1048576) throw new Error('ADP_MAX_RESPONSE_BYTES must be an integer from 1024 to 1048576.');
  if (mode === 'LIVE' && !raw.ADP_APP_KEY) throw new Error('LIVE mode requires ADP_APP_KEY in the local environment.');
  return { ...raw, INTENTLOCK_MODE: mode, ADP_TIMEOUT_MS: timeoutMs, ADP_MAX_RESPONSE_BYTES: maxResponseBytes, PORT: Number(raw.PORT) || 8787, envPath };
}

module.exports = { DEFAULTS, parseDotEnv, loadConfig };
