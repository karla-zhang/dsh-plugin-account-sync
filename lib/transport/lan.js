// LAN transport.
// Host role: opens a small dedicated HTTP listener (the harness web server is
// loopback-only) that serves one data root to other terminals on the LAN.
// Client role: talks to such a host over HTTP with a shared token.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { FolderTransport } from './folder.js'
import { VERSION, ensureDir, messageOf, safeRelPath } from '../util.js'

const API_PREFIX = '/_account-sync'
const MAX_BODY = 128 * 1024 * 1024
const TOKEN_HEADER = 'x-account-sync-token'

function sendJson(res, status, value) {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    body = '{"ok":false}'
    status = 500
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function localAddresses() {
  const out = []
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (!entry || entry.internal) continue
        if (entry.family === 'IPv4' || entry.family === 4) out.push(entry.address)
      }
    }
  } catch {
    /* ignore */
  }
  return [...new Set(out)]
}

export class LanHostServer {
  constructor(options) {
    this.dataRoot = options.dataRoot
    this.store = options.store
    this.token = options.token
    this.deviceId = options.deviceId
    this.deviceName = options.deviceName
    this.port = Number(options.port) || 47810
    this.bind = options.bind || '0.0.0.0'
    this.transport = new FolderTransport(this.dataRoot, { kind: 'lan-host' })
    this.server = null
    this.actualPort = null
    this.secretHeaderName = TOKEN_HEADER
  }

  urls() {
    const port = this.actualPort || this.port
    return localAddresses().map((address) => `http://${address}:${port}/_account-sync`)
  }

  async start() {
    await ensureDir(this.dataRoot)
    let lastError = null
    for (let offset = 0; offset < 20; offset += 1) {
      const port = this.port + offset
      try {
        await new Promise((resolve, reject) => {
          const server = http.createServer((req, res) => {
            this.handle(req, res).catch((error) => {
              try {
                sendJson(res, 500, { ok: false, message: messageOf(error) })
              } catch {
                /* response already gone */
              }
            })
          })
          server.on('error', (error) => {
            if (this.server === server) this.server = null
            reject(error)
          })
          server.listen(port, this.bind, () => {
            this.server = server
            this.actualPort = port
            resolve()
          })
          this.server = server
        })
        this.store?.log('info', `LAN host listening on ${this.bind}:${this.actualPort}`)
        return { ok: true, port: this.actualPort, urls: this.urls() }
      } catch (error) {
        lastError = error
        if (error && error.code === 'EADDRINUSE') continue
        break
      }
    }
    throw new Error(`LAN host failed to listen on ${this.bind}:${this.port}: ${messageOf(lastError)}`)
  }

  async stop() {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise((resolve) => {
      try {
        server.close(() => resolve())
        setTimeout(resolve, 2000)
      } catch {
        resolve()
      }
    })
  }

  authorized(req) {
    if (!this.token) return false
    const header = req.headers && req.headers[TOKEN_HEADER]
    return typeof header === 'string' && header.length === this.token.length && header === this.token
  }

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    if (!url.pathname.startsWith(API_PREFIX)) {
      sendJson(res, 404, { ok: false, message: 'not found' })
      return
    }
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const authOk = this.authorized(req)

    if (route === '/ping' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        deviceId: this.deviceId,
        name: this.deviceName,
        version: VERSION,
        requiresToken: true,
        authenticated: authOk,
      })
      return
    }
    if (!authOk) {
      sendJson(res, 401, { ok: false, message: 'invalid or missing access token' })
      return
    }

    if (route === '/file') {
      const rel = safeRelPath(url.searchParams.get('path') || '')
      if (!rel) {
        sendJson(res, 400, { ok: false, message: 'invalid path' })
        return
      }
      if (req.method === 'GET') {
        try {
          const data = await this.transport.read(rel)
          if (data == null) {
            sendJson(res, 404, { ok: false, message: 'not found' })
            return
          }
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
          res.end(data)
        } catch (error) {
          sendJson(res, 500, { ok: false, message: messageOf(error) })
        }
        return
      }
      if (req.method === 'PUT') {
        try {
          const body = await readBody(req)
          await this.transport.write(rel, body)
          sendJson(res, 200, { ok: true, size: body.length })
        } catch (error) {
          sendJson(res, 500, { ok: false, message: messageOf(error) })
        }
        return
      }
      if (req.method === 'DELETE') {
        await this.transport.remove(rel)
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 405, { ok: false, message: 'method not allowed' })
      return
    }

    if (route === '/list' && req.method === 'GET') {
      const rel = url.searchParams.get('path') || ''
      if (rel && !safeRelPath(rel)) {
        sendJson(res, 400, { ok: false, message: 'invalid path' })
        return
      }
      try {
        const entries = await this.transport.list(rel)
        sendJson(res, 200, { ok: true, entries })
      } catch (error) {
        sendJson(res, 500, { ok: false, message: messageOf(error) })
      }
      return
    }

    sendJson(res, 404, { ok: false, message: 'not found' })
  }
}

function normalizeBase(baseUrl) {
  let url = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  if (!url.endsWith(API_PREFIX)) url = `${url}${API_PREFIX}`
  return url
}

export class LanClientTransport {
  constructor(baseUrl, token) {
    this.kind = 'lan'
    this.baseUrl = normalizeBase(baseUrl)
    this.token = token || ''
  }

  describe() {
    return this.baseUrl || '(not configured)'
  }

  async request(route, options = {}) {
    if (!this.baseUrl) throw new Error('LAN host URL is not configured')
    const url = `${this.baseUrl}${route}`
    const headers = { ...(options.headers || {}) }
    if (this.token) headers[TOKEN_HEADER] = this.token
    let body
    if (options.body != null) {
      body = options.body
      headers['content-length'] = String(Buffer.byteLength(body))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 45000)
    try {
      const response = await fetch(url, { method: options.method || 'GET', headers, body, signal: controller.signal })
      const arrayBuffer = await response.arrayBuffer()
      return { status: response.status, body: Buffer.from(arrayBuffer) }
    } finally {
      clearTimeout(timer)
    }
  }

  async test() {
    if (!this.baseUrl) return { ok: false, message: 'LAN 主机地址未配置 / host URL not configured' }
    try {
      const ping = await this.request('/ping', { timeoutMs: 8000 })
      if (ping.status !== 200) return { ok: false, message: `LAN host returned HTTP ${ping.status}`, detail: this.baseUrl }
      let info = {}
      try {
        info = JSON.parse(ping.body.toString('utf8'))
      } catch {
        info = {}
      }
      const list = await this.request('/list?path=devices', { timeoutMs: 10000 })
      if (list.status === 401) {
        return { ok: false, message: '令牌无效 / invalid access token', detail: info.name || this.baseUrl }
      }
      if (list.status !== 200) {
        return { ok: false, message: `LAN host listing returned HTTP ${list.status}`, detail: this.baseUrl }
      }
      return {
        ok: true,
        message: `已连接到 / connected to ${info.name || 'LAN host'}`,
        detail: `${this.baseUrl} (${info.deviceId || ''})`,
      }
    } catch (error) {
      return { ok: false, message: `无法连接 / cannot reach host: ${messageOf(error)}`, detail: this.baseUrl }
    }
  }

  async read(relPath) {
    const rel = safeRelPath(relPath)
    if (!rel) throw new Error(`unsafe path: ${relPath}`)
    const res = await this.request(`/file?path=${encodeURIComponent(rel)}`, { timeoutMs: 120000 })
    if (res.status === 200) return res.body
    if (res.status === 404) return null
    if (res.status === 401) throw new Error('LAN token rejected by host')
    throw new Error(`LAN host GET ${rel} returned HTTP ${res.status}`)
  }

  async write(relPath, data) {
    const rel = safeRelPath(relPath)
    if (!rel) throw new Error(`unsafe path: ${relPath}`)
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const res = await this.request(`/file?path=${encodeURIComponent(rel)}`, {
      method: 'PUT',
      body: buffer,
      timeoutMs: 180000,
    })
    if (res.status === 401) throw new Error('LAN token rejected by host')
    if (res.status !== 200) throw new Error(`LAN host PUT ${rel} returned HTTP ${res.status}`)
  }

  async list(relDir = '') {
    const rel = relDir ? safeRelPath(relDir) : ''
    if (relDir && !rel) throw new Error(`unsafe path: ${relDir}`)
    const res = await this.request(`/list?path=${encodeURIComponent(rel || '')}`, { timeoutMs: 30000 })
    if (res.status === 401) throw new Error('LAN token rejected by host')
    if (res.status === 404) return []
    if (res.status !== 200) throw new Error(`LAN host list ${relDir || '/'} returned HTTP ${res.status}`)
    try {
      const parsed = JSON.parse(res.body.toString('utf8'))
      return Array.isArray(parsed.entries) ? parsed.entries : []
    } catch {
      return []
    }
  }

  async remove(relPath) {
    const rel = safeRelPath(relPath)
    if (!rel) return
    try {
      await this.request(`/file?path=${encodeURIComponent(rel)}`, { method: 'DELETE', timeoutMs: 30000 })
    } catch {
      /* best effort */
    }
  }

  async begin() {}
  async end() {}
  async close() {}
}

export { API_PREFIX, TOKEN_HEADER, normalizeBase }
