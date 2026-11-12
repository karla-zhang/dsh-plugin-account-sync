// Local content collection: workspaces, session logs and skills/presets.
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_FILE_BYTES,
  MAX_SCAN_FILES,
  MAX_SESSION_BYTES,
  createExcluder,
  escapeSessionDirName,
  humanBytes,
  messageOf,
  readJson,
  sha256Hex,
  walkFiles,
  workspaceKey,
} from './util.js'
import { DEFAULT_EXCLUDES, dshHome, profileDir } from './state.js'

function normalizeWorkspace(entry) {
  if (!entry || typeof entry !== 'object') return null
  const resolvedPath = entry.path || entry.directory || entry.root
  if (typeof resolvedPath !== 'string' || !resolvedPath) return null
  return {
    id: typeof entry.id === 'string' ? entry.id : null,
    path: resolvedPath,
    title: typeof entry.title === 'string' && entry.title ? entry.title : path.basename(resolvedPath),
    sessionIds: Array.isArray(entry.sessionIds) ? entry.sessionIds.filter((id) => typeof id === 'string') : [],
  }
}

/** Registered workspaces, from the workspace service when available, else the storage file. */
export async function listRegisteredWorkspaces(ctx) {
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
    if (service && typeof service.list === 'function') {
      const listed = await service.list()
      const values = Array.isArray(listed) ? listed : listed && typeof listed === 'object' ? Object.values(listed) : []
      const normalized = values.map(normalizeWorkspace).filter(Boolean)
      if (normalized.length > 0) return normalized
    }
  } catch {
    /* fall back to the storage file */
  }
  try {
    const file = path.join(dshHome(), 'storages', 'workspace.json')
    const data = await readJson(file, null)
    const table = data && data.tables && data.tables.workspaces
    if (table && typeof table === 'object') {
      const out = []
      for (const [id, entry] of Object.entries(table)) {
        const normalized = normalizeWorkspace({ id, ...entry })
        if (normalized) out.push(normalized)
      }
      return out
    }
  } catch {
    /* ignore */
  }
  return []
}

/** Apply config.workspacePaths on top of the registered list. */
export function selectWorkspaces(registered, config) {
  const wanted = config.workspacePaths
  if (!Array.isArray(wanted) || wanted.length === 0) {
    if (wanted && wanted.length === 0 && config.workspacePathsExplicitEmpty === true) return []
    return registered
  }
  const byPath = new Map()
  for (const entry of registered) byPath.set(path.resolve(entry.path).toLowerCase(), entry)
  const out = []
  for (const raw of wanted) {
    if (typeof raw !== 'string' || !raw) continue
    const known = byPath.get(path.resolve(raw).toLowerCase())
    out.push(known || { id: null, path: raw, title: path.basename(raw) || raw, sessionIds: [] })
  }
  return out
}

/* ------------------------------------------------------------ workspaces */

export async function hashFiles(root, files) {
  const out = []
  for (const file of files) {
    const target = path.join(root, ...file.rel.split('/'))
    try {
      const buffer = await fs.readFile(target)
      out.push({ rel: file.rel, size: buffer.length, mtime: file.mtime, hash: sha256Hex(buffer) })
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      throw error
    }
  }
  return out
}

export async function scanWorkspace(workspacePath, config) {
  const excluder = createExcluder([], [...DEFAULT_EXCLUDES, ...(config.excludes || [])])
  const { files, skipped, truncated } = await walkFiles(workspacePath, {
    excluded: excluder,
    maxFileBytes: MAX_FILE_BYTES,
    maxFiles: MAX_SCAN_FILES,
  })
  const hashed = await hashFiles(workspacePath, files)
  return {
    key: workspaceKey(workspacePath),
    path: workspacePath,
    title: path.basename(workspacePath) || workspacePath,
    files: hashed,
    skipped,
    truncated,
    scannedAt: new Date().toISOString(),
    totalBytes: hashed.reduce((sum, file) => sum + file.size, 0),
  }
}

/* -------------------------------------------------------------- sessions */

/**
 * DSH keeps one directory per session under ~/.dsh/sessions/<escaped-workspace>/.
 * We read the files verbatim (session.v4.jsonl.zstd) so they can be copied to a
 * peer without decoding.
 */
export async function scanSessions(workspacePath, workspaceKeyValue) {
  const dir = path.join(dshHome(), 'sessions', escapeSessionDirName(workspacePath))
  const sessions = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionDir = path.join(dir, entry.name)
      const { files } = await walkFiles(sessionDir, { maxFileBytes: MAX_SESSION_BYTES, maxFiles: 500 })
      const hashed = await hashFiles(sessionDir, files)
      sessions.push({ sessionId: entry.name, files: hashed })
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  return { key: workspaceKeyValue, path: workspacePath, dir, sessions }
}

/* ---------------------------------------------------------------- skills */

export function skillRoots(workspaces) {
  const roots = [
    { kind: 'user-skills', base: path.join(dshHome(), 'skills') },
    { kind: 'user-presets', base: path.join(dshHome(), 'agent-presets') },
    { kind: 'profile-skills', base: path.join(profileDir(), 'skills') },
    { kind: 'profile-presets', base: path.join(profileDir(), 'agent-presets') },
  ]
  for (const workspace of workspaces) {
    const key = workspaceKey(workspace.path)
    roots.push({ kind: `workspace-${key}-skills`, base: path.join(workspace.path, '.dsh', 'skills') })
    roots.push({ kind: `workspace-${key}-presets`, base: path.join(workspace.path, '.dsh', 'agent-presets') })
  }
  return roots
}

export async function scanSkillRoot(kind, base) {
  const excluder = createExcluder(['node_modules', '.git'], ['**/*.log'])
  const { files } = await walkFiles(base, { excluded: excluder, maxFileBytes: 4 * 1024 * 1024, maxFiles: 2000 })
  if (files.length === 0) return null
  const hashed = await hashFiles(base, files)
  return { kind, base, files: hashed, totalBytes: hashed.reduce((sum, file) => sum + file.size, 0) }
}

export async function collectSkills(workspaces) {
  const out = []
  const errors = []
  for (const root of skillRoots(workspaces)) {
    try {
      const scanned = await scanSkillRoot(root.kind, root.base)
      if (scanned) out.push(scanned)
    } catch (error) {
      errors.push({ kind: root.kind, message: messageOf(error) })
    }
  }
  return { roots: out, errors }
}

export function summarizeScan(scan) {
  return `${scan.files.length} files, ${humanBytes(scan.totalBytes)}`
}
