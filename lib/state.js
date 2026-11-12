// Persistent state for the Account Sync host plugin:
// config.json / state.json / log.ndjson / device.json under <DSH_HOME>/account-sync,
// plus a defensive wrapper around the harness credentials service for secrets.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  VERSION,
  deepMerge,
  ensureDir,
  messageOf,
  nowIso,
  randomHex,
  readJson,
  truncate,
  writeJsonAtomic,
} from './util.js'

export const SECRET_KEYS = ['webdav', 'lan', 'lan-host']
export const LOG_LIMIT = 500

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function profileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit) return explicit
  const profile = process.env.DSH_PROFILE || 'desktop'
  return path.join(dshHome(), 'profiles', profile)
}

export const DEFAULT_EXCLUDES = [
  '**/node_modules',
  '**/.git',
  '**/.venv',
  '**/venv',
  '**/__pycache__',
  '**/.cache',
  '**/.pnpm-store',
  '**/.next',
  '**/.turbo',
  '**/dist',
  '**/build',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/desktop.ini',
  '**/*.sync-conflict-*',
  '**/*.tmp',
]

export function defaultConfig() {
  return {
    transport: 'off',
    deviceName: os.hostname(),
    folder: { path: '' },
    git: { dir: '', remote: '', branch: 'main' },
    webdav: { url: '', username: '' },
    lan: { role: 'host', port: 47810, bind: '0.0.0.0', url: '' },
    // Workspace files are opt-in: a first sync must not upload an arbitrary
    // amount of user data before the user picks the workspaces to share.
    categories: { plugins: true, settings: true, workspaces: false, sessions: true, skills: true },
    workspacePaths: null,
    excludes: [],
    autoSync: { enabled: false, intervalMs: 300000 },
    autoApplyPlugins: true,
  }
}

function pickFirstString(object, keys, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 4) return null
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') {
      const found = pickFirstString(value, keys, depth + 1)
      if (found) return found
    }
  }
  return null
}

/** Best-effort signed-in account extraction; the harness shape may evolve. */
export function pickAccount(raw) {
  const state = raw && typeof raw === 'object' ? raw : {}
  const signedIn = Boolean(
    pickFirstString(state, ['userId', 'user_id', 'uid']) ||
      pickFirstString(state, ['accessToken', 'token']) ||
      state.signedIn === true,
  )
  return {
    signedIn,
    userId: pickFirstString(state, ['userId', 'user_id', 'uid']),
    name: pickFirstString(state, ['displayName', 'nickname', 'userName', 'email', 'name']),
  }
}

export class Store {
  constructor(ctx) {
    this.ctx = ctx
    this.dir = path.join(dshHome(), 'account-sync')
    this.configPath = path.join(this.dir, 'config.json')
    this.statePath = path.join(this.dir, 'state.json')
    this.logPath = path.join(this.dir, 'log.ndjson')
    this.devicePath = path.join(this.dir, 'device.json')
    this.secretsPath = path.join(this.dir, 'secrets.json')
    this.gitRoot = path.join(this.dir, 'git')
    this.lanRoot = path.join(this.dir, 'lan-root')
    this.config = defaultConfig()
    this.state = { version: 1, peers: {}, lastSync: null, createdAt: nowIso() }
    this.device = null
    this.logRing = []
    this.logQueue = Promise.resolve()
    this._credentials = undefined
    this.startedAt = nowIso()
  }

  async init() {
    await ensureDir(this.dir)
    const savedConfig = await readJson(this.configPath, null)
    if (savedConfig && typeof savedConfig === 'object') this.config = deepMerge(defaultConfig(), savedConfig)
    const savedState = await readJson(this.statePath, null)
    if (savedState && typeof savedState === 'object') {
      this.state = { ...this.state, ...savedState, peers: savedState.peers || {} }
    }
    const device = await readJson(this.devicePath, null)
    if (device && typeof device.deviceId === 'string' && device.deviceId) {
      this.device = device
    } else {
      this.device = {
        deviceId: randomHex(8),
        createdAt: nowIso(),
        hostname: os.hostname(),
        platform: process.platform,
      }
      await writeJsonAtomic(this.devicePath, this.device)
    }
    const ring = await this.tailLog(400)
    this.logRing = ring
  }

  /* --------------------------------------------------------------- config */

  getConfig() {
    return this.config
  }

  async saveConfig(patch) {
    const next = deepMerge(defaultConfig(), deepMerge(this.config, patch || {}))
    // Keep secrets out of config.json: strings for password/token are extracted below.
    const clean = JSON.parse(JSON.stringify(next))
    if (clean.webdav) delete clean.webdav.password
    if (clean.lan) delete clean.lan.token
    clean.excludes = Array.isArray(clean.excludes) ? clean.excludes.map(String).slice(0, 60) : []
    clean.workspacePaths = Array.isArray(clean.workspacePaths)
      ? clean.workspacePaths.map(String).slice(0, 80)
      : null
    clean.autoSync = {
      enabled: Boolean(clean.autoSync && clean.autoSync.enabled),
      intervalMs: Math.max(60000, Math.min(24 * 60 * 60 * 1000, Number(clean.autoSync && clean.autoSync.intervalMs) || 300000)),
    }
    clean.autoApplyPlugins = Boolean(clean.autoApplyPlugins)
    clean.transport = ['off', 'folder', 'git', 'webdav', 'lan'].includes(clean.transport) ? clean.transport : 'off'
    if (clean.lan) {
      clean.lan.role = clean.lan.role === 'client' ? 'client' : 'host'
      clean.lan.port = Math.max(1, Math.min(65535, Number(clean.lan.port) || 47810))
      clean.lan.bind = String(clean.lan.bind || '0.0.0.0')
      clean.lan.url = String(clean.lan.url || '')
    }
    this.config = clean
    await writeJsonAtomic(this.configPath, clean)
    return this.config
  }

  async publicConfig() {
    const config = JSON.parse(JSON.stringify(this.config))
    const webdavPassword = await this.getSecret('webdav')
    const lanToken = await this.getSecret('lan')
    const hostToken = await this.getSecret('lan-host')
    config.webdav = { url: config.webdav?.url || '', username: config.webdav?.username || '', passwordSet: Boolean(webdavPassword) }
    config.lan = {
      role: config.lan?.role || 'host',
      port: config.lan?.port || 47810,
      bind: config.lan?.bind || '0.0.0.0',
      url: config.lan?.url || '',
      tokenSet: Boolean(lanToken),
      hostTokenSet: Boolean(hostToken),
    }
    return config
  }

  /* ---------------------------------------------------------------- state */

  async saveState() {
    this.state.updatedAt = nowIso()
    await writeJsonAtomic(this.statePath, this.state)
  }

  async resetState() {
    this.state = { version: 1, peers: {}, lastSync: null, createdAt: this.state.createdAt || nowIso() }
    await writeJsonAtomic(this.statePath, this.state)
  }

  /* ------------------------------------------------------------------ log */

  log(level, text, data) {
    const line = { at: nowIso(), level: ['info', 'warn', 'error'].includes(level) ? level : 'info', text: truncate(text, 1000) }
    this.logRing.push(line)
    if (this.logRing.length > LOG_LIMIT) this.logRing.splice(0, this.logRing.length - LOG_LIMIT)
    let payload
    try {
      payload = `${JSON.stringify(data ? { ...line, data } : line)}\n`
    } catch {
      payload = `${JSON.stringify(line)}\n`
    }
    this.logQueue = this.logQueue
      .then(() => fs.appendFile(this.logPath, payload, 'utf8'))
      .catch(() => {})
    return line
  }

  readLog(limit = 120) {
    const n = Math.max(1, Math.min(LOG_LIMIT, Number(limit) || 120))
    return this.logRing.slice(-n)
  }

  async tailLog(limit = 120) {
    try {
      const text = await fs.readFile(this.logPath, 'utf8')
      const lines = text.trim().split('\n').filter(Boolean).slice(-Math.max(1, limit))
      const out = []
      for (const line of lines) {
        try {
          out.push(JSON.parse(line))
        } catch {
          /* skip damaged line */
        }
      }
      return out
    } catch {
      return []
    }
  }

  /* -------------------------------------------------------------- secrets */

  credentials() {
    if (this._credentials !== undefined) return this._credentials
    let service = null
    try {
      service = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('credentials') : null
    } catch {
      service = null
    }
    if (!service) {
      try {
        service = this.ctx ? this.ctx.credentials : null
      } catch {
        service = null
      }
    }
    this._credentials = service && typeof service.readRecord === 'function' ? service : null
    return this._credentials
  }

  async getSecret(name) {
    const key = `account-sync-${name}`
    const service = this.credentials()
    if (service) {
      try {
        const record = await service.readRecord(key)
        if (record != null) {
          if (typeof record === 'string') return record
          if (typeof record.key === 'string' && record.key) return record.key
          if (typeof record.payload === 'string' && record.payload) return record.payload
          if (record.payload && typeof record.payload.value === 'string') return record.payload.value
          if (record.payload && typeof record.payload.token === 'string') return record.payload.token
        }
        return null
      } catch {
        /* fall through to file */
      }
    }
    const file = await readJson(this.secretsPath, {})
    return file && typeof file[key] === 'string' ? file[key] : null
  }

  async setSecret(name, value) {
    const key = `account-sync-${name}`
    const service = this.credentials()
    if (service && typeof service.modifyRecord === 'function') {
      try {
        if (value) {
          await service.modifyRecord(key, () => ({ kind: 'api-key', key: String(value) }))
        } else if (typeof service.deleteRecord === 'function') {
          await service.deleteRecord(key)
        } else {
          await service.modifyRecord(key, () => undefined)
        }
        return
      } catch {
        /* fall through to file */
      }
    }
    const file = (await readJson(this.secretsPath, {})) || {}
    if (value) file[key] = String(value)
    else delete file[key]
    await writeJsonAtomic(this.secretsPath, file)
    try {
      await fs.chmod(this.secretsPath, 0o600)
    } catch {
      /* best effort on Windows */
    }
  }

  async hasSecret(name) {
    return Boolean(await this.getSecret(name))
  }

  /* ------------------------------------------------------------ identity */

  deviceInfo() {
    return {
      id: this.device?.deviceId || 'unknown',
      name: String(this.config.deviceName || os.hostname() || 'device'),
      hostname: os.hostname(),
      platform: process.platform,
      userId: null,
      appVersion: VERSION,
    }
  }

  async accountInfo() {
    let raw = null
    try {
      const service = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('deepseekAccount') : null
      if (service && typeof service.getState === 'function') {
        raw = await service.getState()
      }
    } catch (error) {
      this.log('warn', `account state unavailable: ${messageOf(error)}`)
    }
    return pickAccount(raw)
  }
}
