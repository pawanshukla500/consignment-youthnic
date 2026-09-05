const { spawn } = require('node:child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', npmCommand, ...process.argv.slice(2)]
  : process.argv.slice(2);
const child = spawn(process.platform === 'win32' ? process.env.ComSpec : npmCommand, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    JWT_SECRET: process.env.JWT_SECRET || 'test-only-jwt-secret-ci-do-not-use-in-production',
    NODE_ENV: process.env.NODE_ENV || 'test',
  },
});

child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
