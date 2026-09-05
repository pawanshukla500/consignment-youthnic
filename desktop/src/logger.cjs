const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function safeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const blocked = /token|password|secret|credential|authorization|cookie|jwt/i;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [
    key,
    blocked.test(key) ? '[redacted]' : typeof value === 'string' ? value.slice(0, 1000) : value,
  ]));
}

function createLogger(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, 'packing-station.log');
  const rotateIfNeeded = () => {
    try {
      if (fs.statSync(logPath).size < MAX_LOG_BYTES) return;
      const rotated = `${logPath}.1`;
      fs.rmSync(rotated, { force: true });
      fs.renameSync(logPath, rotated);
    } catch (_) {
      // Logging must never stop packing operations.
    }
  };
  const write = (level, event, details = {}) => {
    rotateIfNeeded();
    const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...safeDetails(details) }) + '\n';
    try { fs.appendFileSync(logPath, line, { encoding: 'utf8', mode: 0o600 }); } catch (_) {}
  };
  return {
    path: logPath,
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, details) => write('error', event, details),
    async flush() { await fsp.stat(logPath).catch(() => null); },
  };
}

module.exports = { createLogger, MAX_LOG_BYTES };
