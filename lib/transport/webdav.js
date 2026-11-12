// WebDAV transport: PROPFIND for listing, GET/PUT for files, MKCOL for
// collections. Works with any WebDAV server that supports Basic auth
// (Nextcloud, 坚果云, Synology, box.com, ...).
import http from 'node:http'
import https from 'node:https'
import { messageOf, sha256Hex } from '../util.js'

const DEFAULT_TIMEOUT = 45000
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>'

function encodeRel(rel) {
  return String(rel || '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function trimMessage(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > 300 ? `${value.slice(0, 299)}…` : value
}

export class WebdavTransport {
  constructor(options = {}) {
    this.kind = 'webdav'
    this.url = String(options.url || '').trim()
    this.username = String(options.username || '')
    this.password = options.password || ''
    this.base = null
    if (this.url) {
      try {
        this.base = new URL(this.url)
      } catch {
        this.base = null
      }
    }
  }

  describe() {
    return this.url || '(not configured)'
  }

  requireBase() {
    if (!this.base) throw new Error('WebDAV URL is invalid or not configured')
    return this.base
  }

  authHeader() {
    if (!this.username && !this.password) return null
    const token = Buffer.from(`${this.username}:${this.password || ''}`, 'utf8').toString('base64')
    return `Basic ${token}`
  }

  targetUrl(relPath, directory = false) {
    const base = this.requireBase()
    const basePath = base.pathname.replace(/\/+$/, '')
    const encoded = encodeRel(relPath)
    const target = new URL(base.toString())
    target.pathname = `${basePath}${encoded ? `/${encoded}` : ''}${directory ? '/' : ''}` || '/'
    target.search = ''
    return target
  }

  request(method, relPath, options = {}) {
    const target = options.absoluteUrl ? new URL(options.absoluteUrl) : this.targetUrl(relPath, options.directory)
    const isHttps = target.protocol === 'https:'
    const transport = isHttps ? https : http
    const headers = { ...(options.headers || {}) }
    const auth = this.authHeader()
    if (auth) headers.authorization = auth
    if (options.depth != null) headers.depth = String(options.depth)
    if (options.body) headers['content-length'] = Buffer.byteLength(options.body)
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          rejectUnauthorized: options.rejectUnauthorized !== false,
        },
        (res) => {
          const chunks = []
          let size = 0
          res.on('data', (chunk) => {
            size += chunk.length
            if (size <= 256 * 1024) chunks.push(chunk)
          })
          res.on('end', () => {
            resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: Buffer.concat(chunks) })
          })
          res.on('error', reject)
        },
      )
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`WebDAV request timed out after ${Math.round(timeoutMs / 1000)}s`))
      })
      req.on('error', (error) => reject(new Error(`WebDAV ${method} failed: ${messageOf(error)}`)))
      if (options.body) req.write(options.body)
      req.end()
    })
  }

  async test() {
    if (!this.base) return { ok: false, message: 'WebDAV URL 无效 / invalid WebDAV URL' }
    try {
      const probe = await this.request('PROPFIND', '', { depth: 0, body: PROPFIND_BODY, timeoutMs: 30000 })
      if (probe.status === 207 || probe.status === 200 || probe.status === 204) {
        return { ok: true, message: 'WebDAV 可用 / WebDAV reachable', detail: this.url }
      }
      if (probe.status === 401 || probe.status === 403) {
        return { ok: false, message: 'WebDAV 认证失败 / authentication failed (401/403)', detail: this.url }
      }
      if (probe.status === 404) {
        const created = await this.ensureCollection('')
        if (created) return { ok: true, message: 'WebDAV 根目录已创建 / root collection created', detail: this.url }
        return { ok: false, message: 'WebDAV path not found (404)', detail: this.url }
      }
      return { ok: false, message: `WebDAV returned HTTP ${probe.status}`, detail: trimMessage(probe.body?.toString('utf8')) }
    } catch (error) {
      return { ok: false, message: messageOf(error), detail: this.url }
    }
  }

  async ensureCollection(relPath) {
    const segments = String(relPath || '').split('/').filter(Boolean)
    for (let i = 0; i <= segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/')
      try {
        const res = await this.request('MKCOL', prefix, { directory: true, timeoutMs: 20000 })
        if (![201, 200, 204, 301, 302, 405, 409].includes(res.status)) {
          if (res.status === 401) throw new Error('WebDAV authentication failed')
          // 403 on MKCOL can mean "already exists but not allowed": continue and let PUT decide.
          if (res.status !== 403) throw new Error(`MKCOL ${prefix || '/'} returned HTTP ${res.status}`)
        }
      } catch (error) {
        if (i === segments.length) throw error
      }
    }
    return true
  }

  async read(relPath) {
    const res = await this.request('GET', relPath)
    if (res.status === 200) return res.body
    if (res.status === 404) return null
    if (res.status === 401 || res.status === 403) throw new Error('WebDAV authentication failed')
    throw new Error(`WebDAV GET ${relPath} returned HTTP ${res.status}`)
  }

  async write(relPath, data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
    let res = await this.request('PUT', relPath, { body: buffer, timeoutMs: 120000 })
    if (res.status === 409 || res.status === 404) {
      const segments = String(relPath).split('/').filter(Boolean)
      await this.ensureCollection(segments.slice(0, -1).join('/'))
      res = await this.request('PUT', relPath, { body: buffer, timeoutMs: 120000 })
    }
    if (res.status === 401 || res.status === 403) throw new Error('WebDAV authentication failed')
    if (![200, 201, 204].includes(res.status)) {
      throw new Error(`WebDAV PUT ${relPath} returned HTTP ${res.status}`)
    }
  }

  async list(relDir = '') {
    const res = await this.request('PROPFIND', relDir, { depth: 1, body: PROPFIND_BODY })
    if (res.status === 404) return []
    if (res.status === 401 || res.status === 403) throw new Error('WebDAV authentication failed')
    if (res.status !== 207 && res.status !== 200) {
      throw new Error(`WebDAV PROPFIND ${relDir || '/'} returned HTTP ${res.status}`)
    }
    const text = res.body.toString('utf8')
    const hrefs = []
    // Match <d:href>…</d:href> and <D:href>…</D:href> alike; servers differ in
    // namespace prefix casing and some emit un-namespaced href elements.
    const regex = /<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi
    let match
    while ((match = regex.exec(text)) !== null) {
      hrefs.push(match[1].trim())
    }
    const self = this.targetUrl(relDir, true)
    const out = []
    for (const href of hrefs) {
      let url
      try {
        url = new URL(href, `${self.protocol}//${self.host}`)
      } catch {
        continue
      }
      const pathname = decodeURIComponent(url.pathname)
      const selfPath = decodeURIComponent(self.pathname).replace(/\/+$/, '')
      if (pathname.replace(/\/+$/, '') === selfPath) continue
      const prefix = `${selfPath}/`
      if (!pathname.startsWith(prefix)) continue
      const rest = pathname.slice(prefix.length).replace(/\/+$/, '')
      if (!rest || rest.includes('/')) continue
      out.push({ name: rest, dir: href.endsWith('/') })
    }
    return out
  }

  async remove(relPath) {
    try {
      await this.request('DELETE', relPath, { timeoutMs: 30000 })
    } catch {
      /* deletion is best effort */
    }
  }

  async size(relPath) {
    try {
      const res = await this.request('HEAD', relPath)
      if (res.status === 200) {
        const length = Number(res.headers['content-length'])
        return Number.isFinite(length) ? length : 0
      }
    } catch {
      /* ignore */
    }
    return 0
  }

  async begin() {}
  async end() {}
  async close() {}
}

export default WebdavTransport
