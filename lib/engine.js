// Account Sync — host engine.
//
// Owns: persisted state (Store), the selected transport, the optional LAN host,
// the sync job lifecycle (plan/sync are serialised), auto-sync scheduling and
// the JSON API served to the settings page.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Store, dshHome } from './state.js'
import { listRegisteredWorkspaces, selectWorkspaces } from './local.js'
import { FolderTransport } from './transport/folder.js'
import { GitTransport } from './transport/git.js'
import { WebdavTransport } from './transport/webdav.js'
import { LanClientTransport, LanHostServer } from './transport/lan.js'
import {
  CATEGORIES,
  getService,
  normalizeCategories,
  peerSummaries,
  runSync,
} from './sync.js'
import { VERSION, ensureDir, messageOf, nowIso, randomHex, workspaceKey } from './util.js'

const CATEGORY_LABELS = {
  plugins: '插件 / Plugins',
  settings: '设置 / Settings',
  workspaces: '工作区文件 / Workspaces',
  sessions: '会话记录 / Sessions',
  skills: '技能与预设 / Skills & presets',
}

const CATEGORY_SUMMARIES = {
  plugins: '个插件 / bundles',
  settings: '项设置 / settings',
  workspaces: '个工作区 / workspaces',
  sessions: '个工作区有会话 / session workspaces',
  skills: '个技能目录 / skill roots',
}

const ORIGIN_HEADER = 'origin'
const MAX_BODY = 1024 * 1024

export function createEngine(ctx) {
  const store = new Store(ctx)
  let started = false
  let starting = null
  let busy = null
  let autoTimer = null
  let transport = null
  let transportKey = ''
  let lanHost = null
  let lanHostKey = ''
  let lastError = null
  const cache = { peers: [], peersAt: 0, counts: null, countsAt: 0, transportOk: null, account: null }

  /* ------------------------------------------------------------- lifecycle */

  async function start() {
    if (started) return
    if (starting) return starting
    starting = (async () => {
      try {
        await store.init()
        store.log('info', `account-sync ${VERSION} host started (device ${store.device.deviceId})`)
        rescheduleAutoSync()
        if (store.config.transport === 'lan' && store.config.lan.role === 'host') {
          ensureLanHost().catch((error) => store.log('warn', `LAN host failed to start: ${messageOf(error)}`))
        }
        if (store.config.transport !== 'off') {
          const timer = setTimeout(() => {
            refreshPeers().catch(() => {})
            refreshCounts().catch(() => {})
          }, 1500)
          if (typeof timer.unref === 'function') timer.unref()
        }
      } catch (error) {
        store.log('error', `host start failed: ${messageOf(error)}`)
      } finally {
        started = true
        starting = null
      }
    })()
    return starting
  }

  async function stop() {
    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
    const host = lanHost
    lanHost = null
    lanHostKey = ''
    if (host) await host.stop().catch(() => {})
    transport = null
    transportKey = ''
  }

  /* --------------------------------------------------------------- config */

  async function accountInfo() {
    const account = await store.accountInfo()
    if (!account.userId) {
      try {
        const service = getService(ctx, 'deepseekAccount')
        if (service && typeof service.getDeviceIdentity === 'function') {
          const identity = await service.getDeviceIdentity()
          if (identity && identity.userId) {
            account.userId = String(identity.userId)
            account.signedIn = true
          }
        }
      } catch {
        /* identity is optional */
      }
    }
    if (account.userId) account.signedIn = true
    cache.account = account
    return account
  }

  async function saveConfig(patch) {
    await start()
    const next = patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : {}
    const secretWrites = []
    if (next.webdav && Object.prototype.hasOwnProperty.call(next.webdav, 'password')) {
      secretWrites.push(['webdav', next.webdav.password])
      delete next.webdav.password
    }
    if (next.lan && Object.prototype.hasOwnProperty.call(next.lan, 'token')) {
      secretWrites.push(['lan', next.lan.token])
      delete next.lan.token
    }
    const saved = await store.saveConfig(next)
    for (const [name, value] of secretWrites) {
      await store.setSecret(name, value === undefined || value === null || value === '' ? '' : String(value))
    }
    transport = null
    transportKey = ''
    rescheduleAutoSync()
    store.log('info', `config saved (transport=${saved.transport})`)
    if (saved.transport === 'lan' && saved.lan.role === 'host') {
      ensureLanHost().catch((error) => store.log('warn', `LAN host failed to start: ${messageOf(error)}`))
    } else {
      const host = lanHost
      lanHost = null
      lanHostKey = ''
      if (host) await host.stop().catch(() => {})
    }
    cache.transportOk = null
    return await store.publicConfig()
  }

  /* ----------------------------------------------------------- transports */

  function signature() {
    const config = store.config
    return JSON.stringify({
      transport: config.transport,
      folder: config.folder,
      git: config.git,
      webdav: { url: config.webdav && config.webdav.url, username: config.webdav && config.webdav.username },
      lan: config.lan,
    })
  }

  async function ensureLanHost() {
    const config = store.config
    const key = `${config.lan.port}|${config.lan.bind}|${config.deviceName}`
    if (lanHost && lanHostKey === key) return lanHost
    if (lanHost) {
      const previous = lanHost
      lanHost = null
      await previous.stop().catch(() => {})
    }
    let token = await store.getSecret('lan-host')
    if (!token) {
      token = randomHex(16)
      await store.setSecret('lan-host', token)
      store.log('info', 'generated a LAN access token')
    }
    await ensureDir(store.lanRoot)
    const host = new LanHostServer({
      dataRoot: store.lanRoot,
      store,
      token,
      deviceId: store.device.deviceId,
      deviceName: config.deviceName || os.hostname(),
      port: config.lan.port,
      bind: config.lan.bind,
    })
    const result = await host.start()
    lanHost = host
    lanHostKey = key
    store.log('info', `LAN host listening on ${result.port} (${result.urls.join(', ')})`)
    return lanHost
  }

  async function ensureTransport() {
    await start()
    const config = store.config
    if (config.transport === 'off') return null
    const secrets = `${(await store.hasSecret('webdav')) ? 'w' : ''}${(await store.hasSecret('lan')) ? 'l' : ''}${(await store.hasSecret('lan-host')) ? 'h' : ''}`
    const key = `${signature()}|${secrets}`
    if (transport && transportKey === key) return transport
    transport = null
    transportKey = ''
    let built = null
    switch (config.transport) {
      case 'folder': {
        const root = config.folder && config.folder.path
        if (!root) throw new Error('共享文件夹路径未配置 / shared folder path is not configured')
        built = new FolderTransport(root, { kind: 'folder' })
        break
      }
      case 'git':
        built = new GitTransport(ctx, config.git, store)
        break
      case 'webdav': {
        const url = config.webdav && config.webdav.url
        if (!url) throw new Error('WebDAV 地址未配置 / WebDAV URL is not configured')
        built = new WebdavTransport({
          url,
          username: (config.webdav && config.webdav.username) || '',
          password: (await store.getSecret('webdav')) || '',
        })
        break
      }
      case 'lan': {
        if (config.lan.role === 'client') {
          if (!config.lan.url) throw new Error('局域网地址未配置 / LAN host URL is not configured')
          built = new LanClientTransport(config.lan.url, (await store.getSecret('lan')) || '')
        } else {
          await ensureLanHost()
          built = new FolderTransport(store.lanRoot, { kind: 'lan-host' })
        }
        break
      }
      default:
        built = null
    }
    transport = built
    transportKey = built ? key : ''
    return built
  }

  async function test() {
    await start()
    let target = null
    try {
      target = await ensureTransport()
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
    if (!target) return { ok: false, message: '尚未选择传输方式 / no transport selected' }
    let result
    try {
      result = await target.test()
    } catch (error) {
      result = { ok: false, message: messageOf(error) }
    }
    cache.transportOk = Boolean(result && result.ok)
    if (result && result.ok && target.kind === 'lan-host' && lanHost) {
      result.urls = lanHost.urls()
      const token = await store.getSecret('lan-host')
      result.tokenSet = Boolean(token)
      // The pairing token must be readable by the operator of this device only.
      // This response is same-origin only (originAllowed guard) and is not part
      // of the published transport data, so it is safe to show here.
      if (token) result.detail = `配对信息 / pairing · ${result.urls.join(' | ')} · token: ${token}`
    }
    store.log(result && result.ok ? 'info' : 'warn', `transport test: ${result ? result.message : 'unknown'}`)
    return result || { ok: false, message: 'unknown transport error' }
  }

  /* ------------------------------------------------------------- sync ops */

  async function sync(categoryNames) {
    if (busy) return { ok: false, busy: true, operation: busy }
    busy = 'sync'
    const startedAt = nowIso()
    try {
      const target = await ensureTransport()
      if (!target) return { ok: false, message: '尚未选择传输方式 / no transport selected' }
      const account = await accountInfo()
      const categories = categoryObject(categoryNames)
      const env = { ctx, store, config: store.config, transport: target, account }
      const result = await runSync(env, { apply: true, categories })
      store.state.lastSync = result.report
      await store.saveState().catch(() => {})
      cache.transportOk = result.report.errors.length === 0
      cache.peers = await refreshPeers(true).catch(() => cache.peers)
      const report = result.report
      store.log(
        report.errors.length ? 'warn' : 'info',
        `sync finished in ${Date.parse(report.finishedAt) - Date.parse(report.startedAt)}ms ` +
          `(pushed: plugins=${report.pushed.plugins ? 'yes' : 'no'} workspaces=${report.pushed.workspaces.files} sessions=${report.pushed.sessions.files} skills=${report.pushed.skills.files}; ` +
          `pulled: workspaces=${report.pulled.workspaceFiles} sessions=${report.pulled.sessionFiles} skills=${report.pulled.skillFiles}; conflicts=${report.conflicts.length})`,
      )
      return { ok: true, report, plan: result.plan }
    } catch (error) {
      lastError = messageOf(error)
      store.log('error', `sync failed: ${lastError}`)
      return { ok: false, message: lastError }
    } finally {
      busy = null
      void startedAt
    }
  }

  async function plan(categoryNames) {
    if (busy) return { ok: false, busy: true, operation: busy }
    busy = 'plan'
    try {
      const target = await ensureTransport()
      if (!target) return { ok: false, message: '尚未选择传输方式 / no transport selected' }
      const account = await accountInfo()
      const categories = categoryObject(categoryNames)
      const env = { ctx, store, config: store.config, transport: target, account }
      const result = await runSync(env, { apply: false, categories })
      return { ok: true, plan: result.plan, report: result.report }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    } finally {
      busy = null
    }
  }

  function categoryObject(categoryNames) {
    const current = normalizeCategories(store.config.categories)
    if (!Array.isArray(categoryNames) || categoryNames.length === 0) return current
    const out = {}
    for (const key of CATEGORIES) out[key] = false
    for (const name of categoryNames) if (CATEGORIES.includes(name)) out[name] = true
    return out
  }

  /* --------------------------------------------------------------- status */

  async function refreshPeers(force = false) {
    await start()
    const now = Date.now()
    if (!force && cache.peersAt && now - cache.peersAt < 8000) return cache.peers
    let target = transport
    if (!target) {
      try {
        target = await ensureTransport()
      } catch (error) {
        store.log('warn', `transport not ready for peer discovery: ${messageOf(error)}`)
        cache.peersAt = now
        return cache.peers
      }
    }
    if (!target) {
      cache.peersAt = now
      return cache.peers
    }
    try {
      const account = cache.account || (await accountInfo())
      const peers = await peerSummaries({ ctx, store, config: store.config, transport: target, account }, {})
      cache.peers = peers
      cache.peersAt = now
    } catch (error) {
      store.log('warn', `peer discovery failed: ${messageOf(error)}`)
      cache.peersAt = now
    }
    return cache.peers
  }

  async function refreshCounts(force = false) {
    await start()
    const now = Date.now()
    if (!force && cache.counts && cache.countsAt && now - cache.countsAt < 45000) return cache.counts
    const counts = {
      plugins: 0,
      settings: 0,
      workspaces: 0,
      selected: 0,
      sessions: 0,
      skills: 0,
      // Registered workspaces, so the settings page can offer a picker even
      // when config.workspacePaths is null ("all workspaces").
      workspaceList: [],
    }
    try {
      const manager = getService(ctx, 'pluginManager')
      const bundles = manager && typeof manager.listBundles === 'function' ? await manager.listBundles() : []
      counts.plugins = Array.isArray(bundles) ? bundles.length : 0
    } catch {
      /* keep zero */
    }
    try {
      const settings = getService(ctx, 'settings')
      const descriptors = settings && typeof settings.describe === 'function' ? await settings.describe({ redactSecrets: true }) : []
      counts.settings = Array.isArray(descriptors) ? descriptors.length : 0
    } catch {
      /* keep zero */
    }
    try {
      const registered = await listRegisteredWorkspaces(ctx)
      const selected = selectWorkspaces(registered, store.config)
      counts.workspaces = registered.length
      counts.selected = selected.length
      counts.workspaceList = registered.map((entry) => ({
        key: workspaceKey(entry.path),
        path: entry.path,
        title: entry.title,
      }))
    } catch {
      /* keep zero */
    }
    try {
      const dir = path.join(dshHome(), 'sessions')
      const entries = await fs.readdir(dir, { withFileTypes: true })
      counts.sessions = entries.filter((entry) => entry.isDirectory()).length
    } catch {
      /* keep zero */
    }
    try {
      const entries = await fs.readdir(path.join(dshHome(), 'skills'), { withFileTypes: true })
      counts.skills = entries.filter((entry) => entry.isDirectory()).length
    } catch {
      /* keep zero */
    }
    cache.counts = counts
    cache.countsAt = now
    return counts
  }

  function transportState() {
    const config = store.config
    const kind = config.transport
    let configured = false
    if (kind === 'folder') configured = Boolean(config.folder && config.folder.path)
    else if (kind === 'git') configured = true
    else if (kind === 'webdav') configured = Boolean(config.webdav && config.webdav.url)
    else if (kind === 'lan') configured = config.lan.role === 'client' ? Boolean(config.lan.url) : true
    let message = '未启用 / disabled'
    if (kind !== 'off') {
      if (!configured) message = '未配置 / not configured'
      else if (kind === 'lan' && config.lan.role === 'host') {
        message = lanHost ? `已监听 / listening on ${lanHost.urls().join(', ') || 'localhost'}` : '等待启动 / starting'
      } else message = transport && typeof transport.describe === 'function' ? transport.describe() : '未连接 / not connected'
    }
    return { kind, configured, ok: cache.transportOk, message }
  }

  async function status() {
    await start()
    const config = await store.publicConfig()
    const counts = await refreshCounts()
    const account = cache.account || (await accountInfo())
    const categories = {}
    const enabledMap = normalizeCategories(config.categories)
    for (const key of CATEGORIES) {
      const count = counts[key] || 0
      const summary = key === 'workspaces' ? `${counts.selected || 0}/${count} ${CATEGORY_SUMMARIES[key]}` : `${count} ${CATEGORY_SUMMARIES[key]}`
      categories[key] = { enabled: enabledMap[key], label: CATEGORY_LABELS[key], summary, count }
      if (key === 'workspaces') categories[key].list = counts.workspaceList || []
    }
    const lastSyncReport = store.state.lastSync || null
    return {
      ok: true,
      version: VERSION,
      busy: Boolean(busy),
      device: { ...store.deviceInfo(), userId: account.userId || null },
      account: {
        signedIn: Boolean(account.signedIn),
        userId: account.userId || null,
        name: account.name || null,
      },
      transport: transportState(),
      config,
      categories,
      peers: cache.peers || [],
      lastSync: lastSyncReport
        ? { at: lastSyncReport.finishedAt || lastSyncReport.startedAt || '', ok: Array.isArray(lastSyncReport.errors) && lastSyncReport.errors.length === 0, report: lastSyncReport }
        : null,
      autoSync: {
        enabled: Boolean(config.autoSync && config.autoSync.enabled),
        intervalMs: (config.autoSync && config.autoSync.intervalMs) || 300000,
        lastAt: store.state.autoSyncLastAt || null,
      },
      log: store.readLog(40),
      lastError,
    }
  }

  async function reset() {
    await start()
    await store.resetState()
    cache.peers = []
    cache.peersAt = 0
    store.log('info', 'sync state reset')
    return { ok: true }
  }

  /* ------------------------------------------------------------ auto sync */

  function rescheduleAutoSync() {
    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
    const auto = store.config.autoSync
    if (!auto || !auto.enabled) return
    const interval = Math.max(60000, Number(auto.intervalMs) || 300000)
    const tick = async () => {
      autoTimer = null
      try {
        if (store.config.autoSync && store.config.autoSync.enabled && !busy && store.config.transport !== 'off') {
          const last = Date.parse(store.state.autoSyncLastAt || '') || 0
          if (Date.now() - last >= store.config.autoSync.intervalMs) {
            store.state.autoSyncLastAt = nowIso()
            await store.saveState().catch(() => {})
            const result = await sync()
            if (!result.ok) store.log('warn', `auto sync: ${result.message || 'busy'}`)
          }
        }
      } catch (error) {
        store.log('warn', `auto sync failed: ${messageOf(error)}`)
      } finally {
        if (store.config.autoSync && store.config.autoSync.enabled) {
          autoTimer = setTimeout(tick, Math.max(60000, store.config.autoSync.intervalMs))
          if (autoTimer && typeof autoTimer.unref === 'function') autoTimer.unref()
        }
      }
    }
    autoTimer = setTimeout(tick, Math.min(interval, 20000))
    if (autoTimer && typeof autoTimer.unref === 'function') autoTimer.unref()
  }

  /* --------------------------------------------------------------- open */

  async function openTarget(target) {
    const config = store.config
    let dir = store.dir
    if (target === 'transport') {
      if (config.transport === 'folder') dir = config.folder.path || store.dir
      else if (config.transport === 'git') dir = (config.git && config.git.dir) || store.gitRoot
      else if (config.transport === 'lan') dir = store.lanRoot
      else dir = store.dir
    }
    await ensureDir(dir)
    try {
      if (process.platform === 'win32') {
        const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' })
        child.on('error', () => {})
        child.unref()
      } else if (process.platform === 'darwin') {
        spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
      } else {
        spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
      }
      return { ok: true, message: `已打开 / opened ${dir}`, path: dir }
    } catch (error) {
      return { ok: false, message: messageOf(error), path: dir }
    }
  }

  /* ---------------------------------------------------------------- HTTP */

  function originAllowed(request) {
    const header = request.headers[ORIGIN_HEADER]
    if (!header) return true
    try {
      const origin = new URL(header)
      return origin.host === request.headers.host
    } catch {
      return false
    }
  }

  async function readJsonBody(request) {
    const chunks = []
    let size = 0
    await new Promise((resolve, reject) => {
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          reject(new Error('request body too large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', resolve)
      request.on('error', reject)
    })
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('invalid JSON body')
    }
  }

  function sendJson(response, statusCode, payload) {
    if (response.writableEnded) return
    const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(body)
  }

  async function route(method, sub, body) {
    const key = `${method} ${sub}`
    switch (key) {
      case 'GET /status':
      case 'GET /':
        return { statusCode: 200, payload: await status() }
      case 'POST /config':
        return { statusCode: 200, payload: { ok: true, config: await saveConfig(body) } }
      case 'POST /test': {
        const result = await test()
        return { statusCode: 200, payload: { ok: true, ...result } }
      }
      case 'POST /peers': {
        const peers = await refreshPeers(true)
        return { statusCode: 200, payload: { ok: true, peers } }
      }
      case 'POST /plan': {
        const result = await plan(body && body.categories)
        return { statusCode: result.busy ? 409 : 200, payload: result.busy ? result : { ok: true, ...result } }
      }
      case 'POST /sync': {
        const result = await sync(body && body.categories)
        return { statusCode: result.busy ? 409 : 200, payload: result.busy ? result : { ok: true, ...result } }
      }
      case 'POST /log':
        return { statusCode: 200, payload: { ok: true, lines: store.readLog(body && body.limit) } }
      case 'POST /open': {
        const result = await openTarget(body && body.target)
        return { statusCode: result.ok ? 200 : 500, payload: { ok: result.ok, message: result.message } }
      }
      case 'POST /reset': {
        if (body && body.what && body.what !== 'state') {
          return { statusCode: 400, payload: { ok: false, message: 'unsupported reset target' } }
        }
        await reset()
        return { statusCode: 200, payload: { ok: true } }
      }
      default:
        return { statusCode: 404, payload: { ok: false, message: 'not found' } }
    }
  }

  async function handle(request, response) {
    try {
      if (!originAllowed(request)) {
        sendJson(response, 403, { ok: false, message: 'origin not allowed' })
        return
      }
      const url = new URL(request.url || '/', 'http://localhost')
      const pathname = url.pathname.replace(/\/+$/, '') || '/account-sync/api'
      const sub = pathname.replace(/^\/account-sync\/api/, '') || '/'
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.setHeader('allow', 'GET, POST')
        sendJson(response, 405, { ok: false, message: 'method not allowed' })
        return
      }
      let body = {}
      if (request.method === 'POST') {
        try {
          body = await readJsonBody(request)
        } catch (error) {
          sendJson(response, 400, { ok: false, message: messageOf(error) })
          return
        }
      }
      const result = await route(request.method, sub, body)
      sendJson(response, result.statusCode, result.payload)
    } catch (error) {
      store.log('error', `API ${request.method} ${request.url}: ${messageOf(error)}`)
      sendJson(response, 500, { ok: false, message: messageOf(error) })
    }
  }

  function serve(webServer) {
    const disposer = webServer.register({
      kind: 'prefix',
      path: '/account-sync/api',
      handler: (request, response) => handle(request, response),
    })
    store.log('info', 'JSON API registered at /account-sync/api')
    return () => {
      try {
        disposer()
      } catch {
        /* already disposed */
      }
    }
  }

  return {
    start,
    stop,
    serve,
    status,
    test,
    sync,
    plan,
    saveConfig,
    refreshPeers,
    reset,
    openTarget,
    handle,
    get store() {
      return store
    },
  }
}
