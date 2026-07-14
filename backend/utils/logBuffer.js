const logBuffer = [];
const MAX_LOGS = 200;

function addLog(level, message) {
  logBuffer.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.shift();
  }
}

function getLogs() {
  return logBuffer;
}

module.exports = {
  addLog,
  getLogs
};
