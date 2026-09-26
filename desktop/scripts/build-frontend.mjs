import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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

// An installer is handed to an operator who only signs in, so the renderer must
// carry its own Firebase web configuration. Without it the packaged app builds
// and installs cleanly but every sign-in fails.
const REQUIRED_FIREBASE_KEYS = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID']
const missing = REQUIRED_FIREBASE_KEYS.filter((key) => !env[key])
if (missing.length) {
  console.error(`Desktop build refused: no Firebase web configuration for ${missing.join(', ')}.`)
  console.error('Set them in frontend/.env.production (or the shell) so the installed app can sign in.')
  process.exit(1)
}

// The packaged renderer runs on app://youthnic and reaches the backend through
// the main-process /api proxy, so an absolute base URL must never be baked in.
delete env.VITE_API_URL

function verifyRendererBundle() {
  const assets = resolve(frontend, 'dist', 'assets')
  const bundle = readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(resolve(assets, name), 'utf8'))
    .join('\n')
  if (!bundle.includes(env.VITE_FIREBASE_AUTH_DOMAIN)) {
    throw new Error('Desktop build refused: the Firebase auth domain is not present in the renderer bundle; sign-in would fail.')
  }
  // localhost:9999 is a Supabase SDK library default, not our API base.
  // The real risk is localhost:5000 (the dev backend) leaking into the build.
  if (/https?:\/\/localhost:5000/.test(bundle)) {
    throw new Error('Desktop build refused: the dev API base (localhost:5000) was baked into the renderer bundle.')
  }
  console.log('Verified renderer bundle: Firebase sign-in configured, no localhost API base.')
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
  if (code !== 0) {
    process.exitCode = code ?? 1
    return
  }
  try {
    verifyRendererBundle()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
})
