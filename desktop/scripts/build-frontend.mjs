import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '..', '..', 'frontend')
const isWindows = process.platform === 'win32'
const command = isWindows ? process.env.ComSpec : 'npm'
const args = isWindows
  ? ['/d', '/s', '/c', 'npm.cmd', 'run', 'build']
  : ['run', 'build']

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {}
  const values = {}
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match || match[1].startsWith('#')) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

const env = {}
// Match Vite's local env precedence while preserving CI/shell variables.
for (const fileName of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  for (const [key, value] of Object.entries(parseEnvFile(resolve(frontend, fileName)))) {
    env[key] = value
  }
}
Object.assign(env, process.env)

// This repository's example contains the public Firebase web configuration.
// Use it only when no real frontend env supplied Firebase settings; no server
// credentials are ever copied into the renderer build.
if (!env.VITE_FIREBASE_API_KEY) {
  for (const [key, value] of Object.entries(parseEnvFile(resolve(frontend, '.env.example')))) {
    if (key.startsWith('VITE_FIREBASE_') && !env[key]) env[key] = value
  }
}

const child = spawn(command, args, {
  cwd: frontend,
  env: { ...env, VITE_DESKTOP_BUILD: 'true' },
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(`Unable to build the frontend: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Frontend build stopped by ${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
