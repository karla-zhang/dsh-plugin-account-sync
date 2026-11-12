// Small dependency-free helpers shared by the Account Sync host plugin.
// Plain Node ESM only — this plugin deliberately imports nothing from the harness.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export const VERSION = '0.1.0'
export const MAX_FILE_BYTES = 64 * 1024 * 1024 // per-file cap for workspace sync
export const MAX_SESSION_BYTES = 32 * 1024 * 1024
export const MAX_SCAN_FILES = 20000

export const nowIso = () => new Date().toISOString()

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

export function randomHex(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex')
}

export function messageOf(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message || error)
}

export function truncate(text, max = 300) {
  const value = String(text == null ? '' : text)
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function humanBytes(size) {
  const n = Number(size) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeFileAtomic(file, data) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.${randomHex(4)}.tmp`
  await fs.writeFile(tmp, data)
  try {
    await fs.rename(tmp, file)
  } catch (error) {
    // Windows can refuse a rename over a file held open by a reader; retry once.
    if (error && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EEXIST')) {
      await sleep(60)
      await fs.rename(tmp, file)
      return
    }
    throw error
  }
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

export async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ globbing */

function escapeRegExpChar(ch) {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

export function globToRegExp(glob) {
  const source = String(glob || '')
  let out = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '*') {
      if (source[i + 1] === '*') {
        i += 2
        if (source[i] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    out += escapeRegExpChar(ch)
    i += 1
  }
  return new RegExp(`^${out}$`)
}

/** Build a predicate over workspace-relative forward-slash paths. */
export function createExcluder(directories = [], globs = []) {
  const dirs = new Set(directories)
  const patterns = globs.filter(Boolean).map(globToRegExp)
  return function excluded(relPath, isDirectory = false) {
    const rel = relPath.replace(/\\/g, '/')
    const parts = rel.split('/')
    for (const part of parts) {
      if (dirs.has(part)) return true
    }
    for (const pattern of patterns) {
      if (pattern.test(rel)) return true
      if (isDirectory && pattern.test(`${rel}/`)) return true
    }
    return false
  }
}

/* ---------------------------------------------------------------- path safety */

/** Normalize a transport-relative path; returns null when it is unsafe. */
export function safeRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null
  if (relPath.includes('\0')) return null
  let rel = relPath.replace(/\\/g, '/')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null
  const parts = []
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  if (parts.length === 0) return null
  return parts.join('/')
}

/** Join `relPath` under `root`, refusing anything that escapes the root. */
export function joinSafe(root, relPath) {
  const rel = safeRelPath(relPath)
  if (!rel) return null
  const rootResolved = path.resolve(root)
  const target = path.resolve(rootResolved, ...rel.split('/'))
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null
  return target
}

export function workspaceKey(workspacePath) {
  const resolved = path.resolve(String(workspacePath || ''))
  const base = path.basename(resolved) || 'workspace'
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'workspace'
  return `${crypto.createHash('sha1').update(resolved.toLowerCase()).digest('hex').slice(0, 12)}-${slug}`
}

/**
 * DSH stores the session log of a workspace under ~/.dsh/sessions/<escaped>/.
 * Observed shape: '--' + drive/path with ':' removed and '\\' → '-' + '--',
 * every non-ASCII UTF-16 code unit escaped as '~XXXX~'. Verified against
 * existing directories on this machine.
 */
export function escapeSessionDirName(workspacePath) {
  const resolved = String(workspacePath || '')
  let out = ''
  for (let i = 0; i < resolved.length; i += 1) {
    const ch = resolved[i]
    const code = resolved.charCodeAt(i)
    if (ch === '/' || ch === '\\') out += '-'
    else if (ch === ':') continue
    else if (code >= 0x20 && code <= 0x7e) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}~`
  }
  return `--${out}--`
}

/** `<name>.sync-conflict-<peer>-<stamp><ext>` used when both sides changed. */
export function conflictFileName(relPath, peerId, stamp) {
  const rel = relPath.replace(/\\/g, '/')
  const slash = rel.lastIndexOf('/')
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : ''
  const base = slash >= 0 ? rel.slice(slash + 1) : rel
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  const peer = String(peerId || 'peer').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 10) || 'peer'
  return `${dir}${stem}.sync-conflict-${peer}-${stamp}${ext}`
}

export function sanitizeId(value, fallback = 'device') {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
  return cleaned || fallback
}

/* ------------------------------------------------------------- fs walking */

/**
 * Recursively list files under root. Returns { files, skipped, truncated }.
 * files: [{ rel, size, mtime }] with forward-slash relative paths.
 */
export async function walkFiles(root, options = {}) {
  const { excluded = () => false, maxFileBytes = MAX_FILE_BYTES, maxFiles = MAX_SCAN_FILES, signal } = options
  const files = []
  const skipped = []
  let truncated = false
  const queue = ['']

  while (queue.length > 0) {
    if (signal && signal.aborted) break
    const relDir = queue.shift()
    const absDir = relDir ? joinSafe(root, relDir) : path.resolve(root)
    if (!absDir) continue
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch (error) {
      if (error && error.code !== 'ENOENT') skipped.push({ rel: relDir || '.', reason: messageOf(error) })
      continue
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (excluded(rel, entry.isDirectory())) continue
      if (entry.isSymbolicLink()) {
        skipped.push({ rel, reason: 'symlink' })
        continue
      }
      if (entry.isDirectory()) {
        queue.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= maxFiles) {
        truncated = true
        break
      }
      try {
        const stat = await fs.stat(path.join(absDir, entry.name))
        if (stat.size > maxFileBytes) {
          skipped.push({ rel, reason: 'too-large', size: stat.size })
          continue
        }
        files.push({ rel, size: stat.size, mtime: Math.round(stat.mtimeMs) })
      } catch (error) {
        skipped.push({ rel, reason: messageOf(error) })
      }
    }
    if (truncated) break
  }
  return { files, skipped, truncated }
}

/** Read file and hash it; returns null when the file vanished or is too big. */
export async function hashFile(absPath, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = await fs.stat(absPath)
    if (stat.size > maxBytes) return { hash: null, size: stat.size, mtime: Math.round(stat.mtimeMs), tooLarge: true }
    const buffer = await fs.readFile(absPath)
    return { hash: sha256Hex(buffer), size: buffer.length, mtime: Math.round(stat.mtimeMs), buffer }
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/** Deterministic JSON used for cross-device content hashing. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

export function hashJson(value) {
  return sha256Hex(stableStringify(value))
}

export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}
