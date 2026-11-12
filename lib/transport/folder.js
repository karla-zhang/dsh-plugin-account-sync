// Local-directory transport: the reference implementation shared by the
// "shared folder" mode, the LAN host's data root and (as a base) the git mode.
import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, joinSafe, messageOf, safeRelPath, writeFileAtomic } from '../util.js'

export class FolderTransport {
  constructor(root, options = {}) {
    this.kind = options.kind || 'folder'
    this.root = root || ''
    this.readOnly = false
  }

  describe() {
    return this.root || '(not configured)'
  }

  requireRoot() {
    if (!this.root) throw new Error('folder path is not configured')
    return this.root
  }

  async test() {
    if (!this.root) return { ok: false, message: 'folder path is not configured' }
    try {
      await ensureDir(this.root)
      const probe = joinSafe(this.root, `.account-sync-probe-${process.pid}`)
      if (!probe) return { ok: false, message: 'invalid folder path' }
      await fs.writeFile(probe, Buffer.from('ok'))
      const readBack = await fs.readFile(probe, 'utf8')
      await fs.rm(probe, { force: true })
      if (readBack !== 'ok') return { ok: false, message: 'folder is not readable back' }
      return { ok: true, message: `文件夹可用 / folder is writable`, detail: this.root }
    } catch (error) {
      return { ok: false, message: messageOf(error), detail: this.root }
    }
  }

  async read(relPath) {
    const target = joinSafe(this.requireRoot(), relPath)
    if (!target) throw new Error(`unsafe path: ${relPath}`)
    try {
      return await fs.readFile(target)
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
  }

  async write(relPath, data) {
    const target = joinSafe(this.requireRoot(), relPath)
    if (!target) throw new Error(`unsafe path: ${relPath}`)
    await writeFileAtomic(target, data)
  }

  async list(relDir = '') {
    const target = relDir ? joinSafe(this.requireRoot(), relDir) : path.resolve(this.requireRoot())
    if (!target) throw new Error(`unsafe path: ${relDir}`)
    try {
      const entries = await fs.readdir(target, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
  }

  async remove(relPath) {
    const target = joinSafe(this.requireRoot(), relPath)
    if (!target) return
    await fs.rm(target, { recursive: true, force: true })
  }

  async size(relPath) {
    const target = joinSafe(this.requireRoot(), relPath)
    if (!target) return 0
    try {
      const stat = await fs.stat(target)
      return stat.isDirectory() ? 0 : stat.size
    } catch {
      return 0
    }
  }

  async begin() {}
  async end() {}
  async close() {}
}

export { FolderTransport as default }

export function isSafeRelative(relPath) {
  return safeRelPath(relPath) === relPath.replace(/\\/g, '/')
}
