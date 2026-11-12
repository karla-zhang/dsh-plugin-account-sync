// Sync engine: snapshot the local state, publish it under devices/<deviceId>/,
// then merge every other device directory that we are allowed to touch.
//
// Rules (also documented in CONTRACT.md):
//   - every device publishes into its own namespace, so no two writers ever
//     share a file;
//   - deletions never propagate;
//   - workspace/skill content is a three-way merge by content hash, conflicts
//     keep both sides (peer copy saved as <name>.sync-conflict-<peer>-<stamp>);
//   - session logs are append-only, so an existing local log is never replaced.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { dshHome } from './state.js'
import {
  collectSkills,
  listRegisteredWorkspaces,
  scanSessions,
  scanWorkspace,
  selectWorkspaces,
  skillRoots,
} from './local.js'
import {
  VERSION,
  conflictFileName,
  hashFile,
  hashJson,
  humanBytes,
  joinSafe,
  messageOf,
  nowIso,
  readJson,
  sha256Hex,
  stableStringify,
  workspaceKey,
  writeFileAtomic,
} from './util.js'

export const CATEGORIES = ['plugins', 'settings', 'workspaces', 'sessions', 'skills']
const SELF_BUNDLE = 'dsh-plugin-account-sync'
const SELF_ENTRY = 'account-sync'

/* --------------------------------------------------------------- utilities */

export function getService(ctx, name) {
  if (!ctx) return null
  try {
    if (ctx[name]) return ctx[name]
  } catch {
    /* not present */
  }
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(name)
      if (service) return service
    }
  } catch {
    /* not ready */
  }
  return null
}

export function normalizeCategories(input) {
  const out = {}
  for (const key of CATEGORIES) {
    const value = input ? input[key] : undefined
    out[key] = value === undefined || value === null ? true : Boolean(value)
  }
  return out
}

/**
 * Workspace keys embed an absolute path hash, so two terminals that keep the
 * same workspace at different paths get different keys. Match the peer key
 * exactly first, then fall back to the human-readable suffix of the key when
 * exactly one local workspace carries it.
 */
function matchWorkspace(byKey, peerKey) {
  const direct = byKey.get(peerKey)
  if (direct) return direct
  const slug = String(peerKey).includes('-') ? String(peerKey).slice(String(peerKey).indexOf('-') + 1) : String(peerKey)
  if (!slug) return null
  const candidates = [...byKey.values()].filter((workspace) => {
    const local = String(workspace.key)
    return local.slice(local.indexOf('-') + 1) === slug
  })
  return candidates.length === 1 ? candidates[0] : null
}

export function emptyReport(transportName = 'off') {
  const at = nowIso()
  return {
    startedAt: at,
    finishedAt: at,
    transport: transportName,
    pushed: { plugins: false, settings: false, workspaces: { files: 0 }, sessions: { files: 0 }, skills: { files: 0 } },
    pulled: { workspaceFiles: 0, sessionFiles: 0, skillFiles: 0 },
    applied: { pluginInstalls: [], pluginStates: [], settings: [] },
    conflicts: [],
    errors: [],
    peers: [],
  }
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeRemoteJson(transport, rel, value) {
  await transport.write(rel, jsonBuffer(value))
}

async function readRemoteJson(transport, rel) {
  const buffer = await transport.read(rel)
  if (!buffer) return null
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

async function listDirSafe(transport, rel) {
  try {
    return await transport.list(rel)
  } catch {
    return []
  }
}

async function listTree(transport, relDir, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return []
  const out = []
  const entries = await listDirSafe(transport, relDir)
  for (const entry of entries) {
    if (!entry || !entry.name) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.dir) out.push(...(await listTree(transport, rel, depth + 1, maxDepth)))
    else out.push(rel)
  }
  return out
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

/* -------------------------------------------------------- local snapshot */

async function snapshotPlugins(env) {
  const manager = getService(env.ctx, 'pluginManager')
  if (!manager || typeof manager.listBundles !== 'function') throw new Error('pluginManager service is unavailable')
  const bundles = await manager.listBundles()
  const plugins = typeof manager.listPlugins === 'function' ? await manager.listPlugins() : []
  return {
    bundles: (Array.isArray(bundles) ? bundles : []).map((bundle) => ({
      name: bundle.name,
      official: Boolean(bundle.official),
      version: bundle.version || null,
      source: bundle.source || (bundle.installTarget && bundle.installTarget.spec) || null,
      enabled: bundle.enabled !== false,
      installed: bundle.installed !== false,
      availability: bundle.availability || null,
      rows: (Array.isArray(bundle.rows) ? bundle.rows : []).map((row) => ({
        rowId: row.rowId || null,
        moduleName: row.moduleName || null,
        entryId: row.entryId || null,
        enabled: row.enabled !== false,
      })),
    })),
    plugins: (Array.isArray(plugins) ? plugins : []).map((plugin) => ({
      entryId: plugin.entryId,
      moduleName: plugin.moduleName,
      enabled: Boolean(plugin.enabled),
    })),
  }
}

const SECRET_KEY_PATTERN = /(^|[._-])(token|password|passwd|secret|apikey|api_key|authorization|cookie|credential|credentials)($|[._-])/i

function looksSecretKey(key) {
  return SECRET_KEY_PATTERN.test(String(key)) || /token|password|secret|apikey/i.test(String(key))
}

/** Deep-copy a config, dropping keys that look like secrets. */
function redactSecretsDeep(value, depth = 0) {
  if (depth > 12) return value
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (looksSecretKey(key)) continue
    out[key] = redactSecretsDeep(item, depth + 1)
  }
  return out
}

function stripSecretPaths(value, secretPaths) {
  if (!Array.isArray(secretPaths) || secretPaths.length === 0) return redactSecretsDeep(value)
  let current = redactSecretsDeep(value)
  for (const secretPath of secretPaths) {
    if (!Array.isArray(secretPath) || secretPath.length === 0) continue
    if (secretPath.length === 1) {
      if (current && typeof current === 'object') delete current[secretPath[0]]
      continue
    }
    let node = current
    for (let i = 0; i < secretPath.length - 1 && node; i += 1) node = node[secretPath[i]]
    if (node && typeof node === 'object') delete node[secretPath[secretPath.length - 1]]
  }
  return current
}

async function snapshotSettings(env) {
  const result = { entries: [], patch: [], errors: [] }
  const settings = getService(env.ctx, 'settings')
  if (settings && typeof settings.describe === 'function') {
    try {
      const descriptors = await settings.describe({ redactSecrets: true })
      for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
        if (!descriptor || !descriptor.ns || descriptor.ns === SELF_ENTRY) continue
        const secretPaths = (descriptor.secrets || []).map((secret) => secret.path).filter(Array.isArray)
        // A value whose every top-level key is secret is not publishable at all.
        const value = stripSecretPaths(descriptor.value ?? {}, secretPaths)
        if (!value || typeof value !== 'object' || Object.keys(value).length === 0) continue
        result.entries.push({ ns: descriptor.ns, value })
        if (secretPaths.length > 0) result.errors.push({ note: `redacted ${secretPaths.length} secret field(s) in ${descriptor.ns}` })
      }
    } catch (error) {
      result.errors.push({ category: 'settings', message: `describe failed: ${messageOf(error)}` })
    }
  }
  const editor = getService(env.ctx, 'configEditor')
  if (editor && typeof editor.configuration === 'function') {
    try {
      const rows = editor.configuration()
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = row && row.entry && row.entry.options ? row.entry.options.id : null
        if (!id || id === SELF_ENTRY) continue
        const override = row.override
        if (!override || typeof override !== 'object' || Object.keys(override).length === 0) continue
        result.patch.push({ id, name: (row.entry.options.name || null), config: redactSecretsDeep(override) })
      }
    } catch (error) {
      result.errors.push({ category: 'settings', message: `configuration() failed: ${messageOf(error)}` })
    }
  }
  const cleanErrors = result.errors.filter((entry) => entry.category)
  return { entries: result.entries, patch: result.patch, errors: cleanErrors }
}

export async function snapshotLocal(env) {
  const config = env.config
  const categories = normalizeCategories(config.categories)
  const registered = await listRegisteredWorkspaces(env.ctx)
  const selected = selectWorkspaces(registered, config)
  const local = {
    categories,
    registered,
    selected,
    plugins: null,
    settings: null,
    workspaces: [],
    sessions: [],
    skills: { roots: [], errors: [] },
    errors: [],
  }
  if (categories.plugins) {
    try {
      local.plugins = await snapshotPlugins(env)
    } catch (error) {
      local.errors.push({ category: 'plugins', message: messageOf(error) })
    }
  }
  if (categories.settings) {
    try {
      local.settings = await snapshotSettings(env)
      local.errors.push(...(local.settings.errors || []))
    } catch (error) {
      local.errors.push({ category: 'settings', message: messageOf(error) })
    }
  }
  if (categories.workspaces) {
    for (const workspace of selected) {
      try {
        const scan = await scanWorkspace(workspace.path, config)
        scan.filesByRel = new Map(scan.files.map((file) => [file.rel, file]))
        local.workspaces.push(scan)
      } catch (error) {
        local.errors.push({ category: 'workspaces', message: `${workspace.path}: ${messageOf(error)}` })
      }
    }
  }
  if (categories.sessions) {
    // Sessions belong to workspaces, not to the workspace-file selection: a user
    // may sync chat history while keeping workspace files local.  Scan every
    // registered workspace so a session-only setup still publishes/pulls logs.
    for (const workspace of registered) {
      try {
        const scan = await scanSessions(workspace.path, workspaceKey(workspace.path))
        local.sessions.push(scan)
      } catch (error) {
        local.errors.push({ category: 'sessions', message: `${workspace.path}: ${messageOf(error)}` })
      }
    }
  }
  if (categories.skills) {
    try {
      local.skills = await collectSkills(selected)
    } catch (error) {
      local.errors.push({ category: 'skills', message: messageOf(error) })
    }
  }
  return local
}

/* -------------------------------------------------------------- publishing */

export async function publishSnapshot(env, local, report) {
  const { store, transport, config } = env
  const deviceId = store.device.deviceId
  const prefix = `devices/${deviceId}`
  const account = env.account || { userId: null }

  await writeRemoteJson(transport, `${prefix}/device.json`, {
    deviceId,
    name: config.deviceName || os.hostname(),
    hostname: os.hostname(),
    platform: process.platform,
    userId: account.userId || (store.device.userId ?? null),
    appVersion: VERSION,
    updatedAt: nowIso(),
  })

  if (local.plugins) {
    await writeRemoteJson(transport, `${prefix}/plugins.json`, {
      generatedAt: nowIso(),
      deviceId,
      bundles: local.plugins.bundles,
    })
    report.pushed.plugins = true
  }

  if (local.settings) {
    await writeRemoteJson(transport, `${prefix}/settings.json`, {
      generatedAt: nowIso(),
      deviceId,
      entries: local.settings.entries,
      patch: local.settings.patch,
    })
    report.pushed.settings = true
  }

  store.state.locals = store.state.locals || {}
  store.state.locals.workspaces = store.state.locals.workspaces || {}
  let workspaceFiles = 0
  for (const workspace of local.workspaces) {
    const key = workspace.key
    const previous = store.state.locals.workspaces[key] || {}
    const manifest = {
      key,
      path: workspace.path,
      title: workspace.title,
      deviceId,
      scannedAt: workspace.scannedAt,
      truncated: Boolean(workspace.truncated),
      files: {},
    }
    for (const file of workspace.files) {
      manifest.files[file.rel] = { hash: file.hash, size: file.size, mtime: file.mtime }
      if (previous[file.rel] === file.hash) continue
      const absolute = joinSafe(workspace.path, file.rel)
      if (!absolute) continue
      let buffer
      try {
        buffer = await fs.readFile(absolute)
      } catch {
        continue
      }
      await transport.write(`${prefix}/workspaces/${key}/blobs/${file.hash}`, buffer)
      workspaceFiles += 1
    }
    await writeRemoteJson(transport, `${prefix}/workspaces/${key}/manifest.json`, manifest)
    store.state.locals.workspaces[key] = Object.fromEntries(workspace.files.map((file) => [file.rel, file.hash]))
  }
  report.pushed.workspaces.files = workspaceFiles

  store.state.locals.sessions = store.state.locals.sessions || {}
  let sessionFiles = 0
  for (const workspace of local.sessions) {
    for (const session of workspace.sessions) {
      for (const file of session.files) {
        const stateKey = `${workspace.key}/${session.sessionId}/${file.rel}`
        if (store.state.locals.sessions[stateKey] === file.hash) continue
        const absolute = path.join(workspace.dir, session.sessionId, ...file.rel.split('/'))
        let buffer
        try {
          buffer = await fs.readFile(absolute)
        } catch {
          continue
        }
        await transport.write(`${prefix}/sessions/${workspace.key}/${session.sessionId}/${file.rel}`, buffer)
        store.state.locals.sessions[stateKey] = file.hash
        sessionFiles += 1
      }
    }
  }
  report.pushed.sessions.files = sessionFiles

  store.state.locals.skills = store.state.locals.skills || {}
  let skillFiles = 0
  for (const root of local.skills.roots || []) {
    for (const file of root.files) {
      const stateKey = `${root.kind}/${file.rel}`
      if (store.state.locals.skills[stateKey] === file.hash) continue
      const absolute = joinSafe(root.base, file.rel)
      if (!absolute) continue
      let buffer
      try {
        buffer = await fs.readFile(absolute)
      } catch {
        continue
      }
      await transport.write(`${prefix}/skills/${root.kind}/${file.rel}`, buffer)
      store.state.locals.skills[stateKey] = file.hash
      skillFiles += 1
    }
  }
  report.pushed.skills.files = skillFiles

  await store.saveState()
}

/* ------------------------------------------------------------------ peers */

export async function readPeerDirectories(env) {
  const { store, transport } = env
  const selfId = store.device.deviceId
  const listing = await listDirSafe(transport, 'devices')
  const peers = []
  for (const entry of listing) {
    if (!entry || !entry.dir) continue
    const id = entry.name
    if (!id || id === selfId) continue
    let device = null
    try {
      device = await readRemoteJson(transport, `devices/${id}/device.json`)
    } catch {
      device = null
    }
    peers.push({
      id,
      prefix: `devices/${id}`,
      device: device || { deviceId: id, name: id, hostname: '', platform: '', userId: null, updatedAt: null },
      reachable: Boolean(device),
    })
  }
  return peers
}

export function sameAccount(selfAccount, peerDevice) {
  const self = selfAccount && selfAccount.userId ? selfAccount.userId : null
  const peer = peerDevice && peerDevice.userId ? peerDevice.userId : null
  if (self && peer && self !== peer) return false
  return true
}

export async function peerSummaries(env, local) {
  const peers = await readPeerDirectories(env)
  const selfAccount = env.account || { userId: null }
  const out = []
  for (const peer of peers) {
    const counts = await peerCategoryCounts(env, peer)
    out.push({
      deviceId: peer.id,
      name: peer.device.name || peer.id,
      hostname: peer.device.hostname || '',
      platform: peer.device.platform || '',
      userId: peer.device.userId || null,
      sameAccount: sameAccount(selfAccount, peer.device),
      isSelf: false,
      updatedAt: peer.device.updatedAt || '',
      categories: counts,
      reachable: peer.reachable,
    })
  }
  return out
}

async function peerCategoryCounts(env, peer) {
  const transport = env.transport
  const counts = { plugins: 0, settings: 0, workspaces: 0, sessions: 0, skills: 0 }
  try {
    const plugins = await readRemoteJson(transport, `${peer.prefix}/plugins.json`)
    counts.plugins = Array.isArray(plugins?.bundles) ? plugins.bundles.length : 0
  } catch {
    /* ignore */
  }
  try {
    const settings = await readRemoteJson(transport, `${peer.prefix}/settings.json`)
    counts.settings = Array.isArray(settings?.entries) ? settings.entries.length : 0
  } catch {
    /* ignore */
  }
  try {
    counts.workspaces = (await listDirSafe(transport, `${peer.prefix}/workspaces`)).filter((entry) => entry.dir).length
    counts.sessions = (await listDirSafe(transport, `${peer.prefix}/sessions`)).filter((entry) => entry.dir).length
    counts.skills = (await listDirSafe(transport, `${peer.prefix}/skills`)).filter((entry) => entry.dir).length
  } catch {
    /* ignore */
  }
  return counts
}

/* ------------------------------------------------------------------- plan */

function createSink(options) {
  const sink = {
    apply: Boolean(options.apply),
    report: options.report,
    plan: options.plan,
    items: 0,
    item(category, peer, title, detail, action) {
      if (sink.items >= 400) return
      sink.items += 1
      sink.plan.items.push({
        id: `${category}:${peer}:${sink.items}`,
        category,
        peer,
        title,
        detail: detail || '',
        action: action || 'sync',
      })
    },
    conflict(category, pathValue, peer, savedAs) {
      const entry = { category, path: pathValue, peer, savedAs: savedAs || undefined }
      sink.plan.conflicts.push({ ...entry, id: `conflict:${category}:${peer}:${sink.plan.conflicts.length}`, title: pathValue, detail: '', action: 'conflict' })
      if (sink.apply) sink.report.conflicts.push(entry)
    },
  }
  return sink
}

/* ------------------------------------------------------------------- pull */

async function pullPlugins(env, local, peer, applied, sink) {
  const data = await readRemoteJson(env.transport, `${peer.prefix}/plugins.json`)
  if (!data || !Array.isArray(data.bundles)) return
  const manager = getService(env.ctx, 'pluginManager')
  const localBundles = new Map((local.plugins?.bundles || []).map((bundle) => [bundle.name, bundle]))
  applied.plugins = applied.plugins || { byName: {} }
  const byName = applied.plugins.byName
  for (const bundle of data.bundles) {
    if (!bundle || typeof bundle.name !== 'string' || !bundle.name) continue
    if (bundle.name === SELF_BUNDLE) continue
    const localBundle = localBundles.get(bundle.name)
    const wanted = bundle.enabled !== false
    if (!localBundle) {
      if (!env.config.autoApplyPlugins) continue
      if (bundle.official || bundle.name.startsWith('@deepseek-ai/')) {
        sink.item('plugins', peer.id, `官方插件不同步 / official ${bundle.name}`, 'official bundles follow the DSH installation', 'skip')
        continue
      }
      if (!bundle.source || bundle.installed === false) continue
      if (!sink.apply) {
        sink.item('plugins', peer.id, `安装 / install ${bundle.name}`, `${bundle.version || ''} ${bundle.source}`, 'install')
        continue
      }
      if (!manager || typeof manager.installBundle !== 'function') {
        sink.report.errors.push({ category: 'plugins', message: 'pluginManager service is unavailable' })
        return
      }
      const entry = { name: bundle.name, version: bundle.version || '', ok: false, message: '' }
      try {
        const result = await manager.installBundle(bundle.source, { enabled: wanted })
        entry.ok = true
        entry.message = (result && (result.application || (result.changed ? 'installed' : 'unchanged'))) || 'installed'
        byName[bundle.name] = { enabled: wanted }
      } catch (error) {
        entry.message = messageOf(error)
      }
      sink.report.applied.pluginInstalls.push(entry)
      continue
    }
    if (localBundle.enabled === wanted) {
      byName[bundle.name] = { enabled: wanted }
      continue
    }
    const base = byName[bundle.name]
    if (base && base.enabled !== localBundle.enabled) {
      sink.conflict('plugins', bundle.name, peer.id)
      continue
    }
    if (!sink.apply) {
      sink.item('plugins', peer.id, `${wanted ? '启用' : '停用'} / ${wanted ? 'enable' : 'disable'} ${bundle.name}`, '', wanted ? 'enable' : 'disable')
      continue
    }
    if (!manager || typeof manager.setBundleEnabled !== 'function') return
    try {
      await manager.setBundleEnabled(bundle.name, wanted)
      byName[bundle.name] = { enabled: wanted }
      sink.report.applied.pluginStates.push({ name: bundle.name, enabled: wanted, ok: true, message: 'updated' })
    } catch (error) {
      sink.report.applied.pluginStates.push({ name: bundle.name, enabled: wanted, ok: false, message: messageOf(error) })
    }
  }
}

function diffSetOps(current, next) {
  const ops = []
  const currentObject = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  const nextObject = next && typeof next === 'object' && !Array.isArray(next) ? next : {}
  for (const [key, value] of Object.entries(nextObject)) {
    if (stableStringify(currentObject[key]) === stableStringify(value)) continue
    ops.push({ op: 'set', path: [key], value })
  }
  return ops
}

async function pullSettings(env, local, peer, applied, sink) {
  const data = await readRemoteJson(env.transport, `${peer.prefix}/settings.json`)
  if (!data) return
  const settings = getService(env.ctx, 'settings')
  const editor = getService(env.ctx, 'configEditor')
  applied.settings = applied.settings || {}
  applied.patch = applied.patch || {}
  const localEntries = new Map((local.settings?.entries || []).map((entry) => [entry.ns, entry]))
  for (const entry of data.entries || []) {
    if (!entry || typeof entry.ns !== 'string' || !entry.ns) continue
    if (entry.ns === SELF_ENTRY) continue
    const peerHash = hashJson(entry.value)
    const localEntry = localEntries.get(entry.ns)
    const localHash = localEntry ? hashJson(localEntry.value) : null
    if (localHash === peerHash) {
      applied.settings[entry.ns] = peerHash
      continue
    }
    if (applied.settings[entry.ns] && localHash !== applied.settings[entry.ns]) {
      sink.conflict('settings', entry.ns, peer.id)
      continue
    }
    const ops = diffSetOps(localEntry ? localEntry.value : {}, entry.value)
    if (ops.length === 0) {
      applied.settings[entry.ns] = peerHash
      continue
    }
    if (!sink.apply) {
      sink.item('settings', peer.id, `应用设置 / apply ${entry.ns}`, ops.map((op) => op.path.join('.')).join(', '), 'apply')
      continue
    }
    if (!settings || typeof settings.mutate !== 'function') {
      sink.report.errors.push({ category: 'settings', message: 'settings service is unavailable' })
      return
    }
    try {
      await settings.mutate(entry.ns, ops)
      applied.settings[entry.ns] = peerHash
      sink.report.applied.settings.push({ ns: entry.ns, ok: true, message: `${ops.length} field(s)` })
    } catch (error) {
      sink.report.applied.settings.push({ ns: entry.ns, ok: false, message: messageOf(error) })
    }
  }

  const localPatches = new Map((local.settings?.patch || []).map((entry) => [entry.id, entry]))
  let entriesCache = null
  for (const row of data.patch || []) {
    if (!row || typeof row.id !== 'string' || !row.id || row.id === SELF_ENTRY) continue
    const peerHash = hashJson(row.config)
    const localRow = localPatches.get(row.id)
    const localHash = localRow ? hashJson(localRow.config) : null
    if (localHash === peerHash) {
      applied.patch[row.id] = peerHash
      continue
    }
    if (applied.patch[row.id] && localHash !== applied.patch[row.id]) {
      sink.conflict('settings', row.id, peer.id)
      continue
    }
    if (sink.apply && (!editor || typeof editor.edit !== 'function')) continue
    let loaderEntry = null
    if (sink.apply) {
      try {
        entriesCache = entriesCache || editor.entries()
        loaderEntry = entriesCache.find((candidate) => candidate && candidate.options && candidate.options.id === row.id) || null
      } catch {
        loaderEntry = null
      }
      if (!loaderEntry) continue
    }
    if (!sink.apply) {
      sink.item('settings', peer.id, `应用配置 / apply config ${row.id}`, row.name || '', 'apply')
      continue
    }
    try {
      await editor.edit(loaderEntry, () => JSON.parse(JSON.stringify(row.config)))
      applied.patch[row.id] = peerHash
      sink.report.applied.settings.push({ ns: row.id, ok: true, message: 'config updated' })
    } catch (error) {
      sink.report.applied.settings.push({ ns: row.id, ok: false, message: messageOf(error) })
    }
  }
}

async function pullWorkspaces(env, local, peer, applied, sink) {
  const transport = env.transport
  const localByKey = new Map(local.workspaces.map((workspace) => [workspace.key, workspace]))
  applied.workspaces = applied.workspaces || {}
  const peerWorkspaces = (await listDirSafe(transport, `${peer.prefix}/workspaces`)).filter((entry) => entry.dir)
  for (const directory of peerWorkspaces) {
    const key = directory.name
    const localWorkspace = matchWorkspace(localByKey, key)
    if (!localWorkspace) continue
    const manifest = await readRemoteJson(transport, `${peer.prefix}/workspaces/${key}/manifest.json`)
    if (!manifest || !manifest.files) continue
    const base = (applied.workspaces[localWorkspace.key] = applied.workspaces[localWorkspace.key] || {})
    for (const rel of Object.keys(manifest.files)) {
      const meta = manifest.files[rel]
      if (!meta || !meta.hash) continue
      const peerHash = meta.hash
      const localFile = localWorkspace.filesByRel.get(rel)
      const localHash = localFile ? localFile.hash : null
      if (localHash === peerHash) {
        base[rel] = peerHash
        continue
      }
      const pull = async () => {
        const blob = await transport.read(`${peer.prefix}/workspaces/${key}/blobs/${peerHash}`)
        if (!blob) {
          sink.report.errors.push({ category: 'workspaces', message: `missing blob for ${rel}` })
          return false
        }
        const absolute = joinSafe(localWorkspace.path, rel)
        if (!absolute) return false
        await writeFileAtomic(absolute, blob)
        base[rel] = peerHash
        sink.report.pulled.workspaceFiles += 1
        return true
      }
      // A conflict is remembered as { hash, peerHash, peer, conflict } so later
      // syncs do not silently let the peer version overwrite the local one.
      const seenRaw = base[rel]
      const seen = seenRaw == null ? null : typeof seenRaw === 'string' ? { hash: seenRaw } : seenRaw
      const seenHash = seen ? seen.hash : null
      const saveConflict = async () => {
        const resolvedHash = localHash || peerHash
        const realConflicts = Boolean(localHash && peerHash)
        const record = { hash: resolvedHash, peerHash, peer: peer.id, conflict: realConflicts }
        base[rel] = record
        if (!realConflicts) {
          // Nothing local to preserve (import path) — no conflicting copy needed.
          return
        }
        const savedRel = conflictFileName(rel, peer.id, timestampSlug())
        sink.conflict('workspaces', rel, peer.id, savedRel)
        if (!sink.apply) return
        const blob = await transport.read(`${peer.prefix}/workspaces/${key}/blobs/${peerHash}`)
        if (blob) {
          const absolute = joinSafe(localWorkspace.path, savedRel)
          if (absolute) await writeFileAtomic(absolute, blob)
        }
      }
      if (!localFile) {
        if (sink.apply) {
          await pull()
        } else {
          sink.item('workspaces', peer.id, `下载 / pull ${rel}`, humanBytes(meta.size || 0), 'pull')
        }
        continue
      }
      if (seen && seen.conflict) {
        if (localHash === seen.hash && peerHash === seen.peerHash) continue
        if (localHash === seen.hash) {
          // Peer edited again while the conflict is unresolved: keep a fresh copy.
          await saveConflict()
          continue
        }
        // Local changed: refresh the recorded base but stay in conflict state.
        base[rel] = { hash: localHash, peerHash, peer: peer.id, conflict: true }
        continue
      }
      if (seen == null) {
        await saveConflict()
        continue
      }
      const localChanged = localHash !== seenHash
      const peerChanged = peerHash !== seenHash
      if (peerChanged && !localChanged) {
        if (sink.apply) await pull()
        else sink.item('workspaces', peer.id, `更新 / update ${rel}`, humanBytes(meta.size || 0), 'pull')
        continue
      }
      if (peerChanged && localChanged) {
        await saveConflict()
        continue
      }
      base[rel] = localHash
    }
  }
}

async function pullSessions(env, local, peer, applied, sink) {
  const transport = env.transport
  const localByKey = new Map(local.sessions.map((workspace) => [workspace.key, workspace]))
  applied.sessions = applied.sessions || {}
  const peerWorkspaces = (await listDirSafe(transport, `${peer.prefix}/sessions`)).filter((entry) => entry.dir)
  for (const directory of peerWorkspaces) {
    const workspace = matchWorkspace(localByKey, directory.name)
    if (!workspace) continue
    const sessionDirectories = (await listDirSafe(transport, `${peer.prefix}/sessions/${directory.name}`)).filter((entry) => entry.dir)
    for (const sessionDirectory of sessionDirectories) {
      const sessionId = sessionDirectory.name
      const sessionBase = `${peer.prefix}/sessions/${directory.name}/${sessionId}`
      const files = await listTree(transport, sessionBase)
      for (const fullRel of files) {
        // listTree returns paths relative to the transport root; work with the
        // path inside the session directory for local placement and state keys.
        const rel = fullRel.startsWith(`${sessionBase}/`) ? fullRel.slice(sessionBase.length + 1) : fullRel
        const stateKey = `${workspace.key}/${sessionId}/${rel}`
        const localPath = path.join(dshHome(), 'sessions', path.basename(workspace.dir), sessionId, ...rel.split('/'))
        const localInfo = await hashFile(localPath)
        const remote = await transport.read(fullRel)
        if (!remote) continue
        const remoteHash = sha256Hex(remote)
        if (localInfo && localInfo.hash === remoteHash) {
          applied.sessions[stateKey] = remoteHash
          continue
        }
        if (!localInfo) {
          if (!sink.apply) {
            sink.item('sessions', peer.id, `导入会话 / import ${sessionId}`, rel, 'import')
            continue
          }
          await writeFileAtomic(localPath, remote)
          applied.sessions[stateKey] = remoteHash
          sink.report.pulled.sessionFiles += 1
          continue
        }
        // Existing local session log: never overwrite an append-only log.
        if (applied.sessions[stateKey] === localInfo.hash) continue
        applied.sessions[stateKey] = localInfo.hash
        sink.conflict('sessions', stateKey, peer.id)
      }
    }
  }
}

async function pullSkills(env, local, peer, applied, sink) {
  const transport = env.transport
  const roots = new Map(skillRoots(local.selected).map((root) => [root.kind, root.base]))
  applied.skills = applied.skills || {}
  const peerKinds = (await listDirSafe(transport, `${peer.prefix}/skills`)).filter((entry) => entry.dir)
  for (const kindDirectory of peerKinds) {
    const base = roots.get(kindDirectory.name)
    if (!base) continue
    const kindBase = `${peer.prefix}/skills/${kindDirectory.name}`
    const files = await listTree(transport, kindBase)
    for (const fullRel of files) {
      const rel = fullRel.startsWith(`${kindBase}/`) ? fullRel.slice(kindBase.length + 1) : fullRel
      const stateKey = `${kindDirectory.name}/${rel}`
      const localPath = joinSafe(base, rel)
      if (!localPath) continue
      const localInfo = await hashFile(localPath)
      const remote = await transport.read(fullRel)
      if (!remote) continue
      const remoteHash = sha256Hex(remote)
      if (localInfo && localInfo.hash === remoteHash) {
        applied.skills[stateKey] = remoteHash
        continue
      }
      if (!localInfo) {
        if (!sink.apply) {
          sink.item('skills', peer.id, `导入 / import ${rel}`, kindDirectory.name, 'import')
          continue
        }
        await writeFileAtomic(localPath, remote)
        applied.skills[stateKey] = remoteHash
        sink.report.pulled.skillFiles += 1
        continue
      }
      if (applied.skills[stateKey] === localInfo.hash) continue
      const savedRel = conflictFileName(rel, peer.id, timestampSlug())
      if (sink.apply) {
        const savedPath = joinSafe(base, savedRel)
        if (savedPath) await writeFileAtomic(savedPath, remote)
        sink.conflict('skills', stateKey, peer.id, savedRel)
        applied.skills[stateKey] = localInfo.hash
      } else {
        sink.conflict('skills', stateKey, peer.id, savedRel)
        applied.skills[stateKey] = localInfo.hash
      }
    }
  }
}

async function syncPeer(env, local, peer, sink) {
  const selfAccount = env.account || { userId: null }
  if (!sameAccount(selfAccount, peer.device)) {
    sink.item('account', peer.id, '账户不同，已跳过 / different account, skipped', peer.device.name || peer.id, 'skip')
    return
  }
  const state = (env.store.state.peers[peer.id] = env.store.state.peers[peer.id] || {})
  const stored = (state.applied = state.applied || {})
  // Dry runs must be side-effect free: mutate a throw-away copy of the merged
  // base hashes, otherwise a second /plan would hide the conflict it reported.
  const applied = sink.apply ? stored : JSON.parse(JSON.stringify(stored))
  const categories = normalizeCategories(env.config.categories)
  const tasks = [
    ['plugins', pullPlugins],
    ['settings', pullSettings],
    ['workspaces', pullWorkspaces],
    ['sessions', pullSessions],
    ['skills', pullSkills],
  ]
  for (const [category, task] of tasks) {
    if (!categories[category]) continue
    try {
      await task(env, local, peer, applied, sink)
    } catch (error) {
      const message = `${peer.device.name || peer.id}: ${messageOf(error)}`
      if (sink.apply) sink.report.errors.push({ category, message })
      else sink.plan.items.push({ id: `error:${category}:${peer.id}`, category, peer: peer.id, title: 'error', detail: message, action: 'error' })
    }
  }
  if (sink.apply) state.updatedAt = nowIso()
}

/* ------------------------------------------------------------------- run */

/**
 * @param {object} env {ctx, store, config, transport, account, log}
 * @param {{apply?: boolean, categories?: object}} options
 * @returns {Promise<{report, plan, local, peers}>}
 */
export async function runSync(env, options = {}) {
  const startedAt = nowIso()
  const categories = normalizeCategories(options.categories || env.config.categories)
  const report = emptyReport(env.config.transport)
  report.startedAt = startedAt
  const plan = { generatedAt: startedAt, peers: [], items: [], conflicts: [] }
  const sink = createSink({ apply: Boolean(options.apply), report, plan })

  const local = await snapshotLocal({ ...env, config: { ...env.config, categories } })
  for (const error of local.errors) report.errors.push(error)

  if (!env.transport) {
    report.errors.push({ category: 'transport', message: 'transport is not configured' })
    report.finishedAt = nowIso()
    return { report, plan, local, peers: [] }
  }

  if (options.apply) {
    try {
      await env.transport.begin()
    } catch (error) {
      report.errors.push({ category: 'transport', message: `begin: ${messageOf(error)}` })
      report.finishedAt = nowIso()
      return { report, plan, local, peers: [] }
    }
    try {
      await publishSnapshot(env, local, report)
    } catch (error) {
      report.errors.push({ category: 'publish', message: messageOf(error) })
    }
  } else if (typeof env.transport.prepare === 'function') {
    try {
      await env.transport.prepare()
    } catch {
      /* dry run may still inspect an existing directory */
    }
  }

  const peers = await readPeerDirectories(env)
  for (const peer of peers) {
    report.peers.push(peer.id)
    plan.peers.push({
      deviceId: peer.id,
      name: peer.device.name || peer.id,
      hostname: peer.device.hostname || '',
      platform: peer.device.platform || '',
      userId: peer.device.userId || null,
      sameAccount: sameAccount(env.account, peer.device),
      isSelf: false,
      updatedAt: peer.device.updatedAt || '',
      categories: await peerCategoryCounts(env, peer),
      reachable: peer.reachable,
    })
    try {
      await syncPeer(env, local, peer, sink)
    } catch (error) {
      report.errors.push({ category: 'peer', message: `${peer.device.name || peer.id}: ${messageOf(error)}` })
    }
  }

  if (options.apply) {
    try {
      const endResult = await env.transport.end({ deviceName: env.config.deviceName })
      if (endResult && endResult.pushed === false) report.pushed.settings = report.pushed.settings
    } catch (error) {
      report.errors.push({ category: 'transport', message: `end: ${messageOf(error)}` })
    }
    env.store.state.lastSync = report
    await env.store.saveState()
  }

  report.finishedAt = nowIso()
  return { report, plan, local, peers }
}

export { SELF_BUNDLE, SELF_ENTRY }
