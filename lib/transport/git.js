// Git transport: a local clone that is pulled before a sync and committed +
// pushed after it. All git invocations go through the harness subprocess
// service (never node:child_process).
import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, messageOf, pathExists } from '../util.js'
import { FolderTransport } from './folder.js'

const GIT_TIMEOUT_MS = 180000

function readCollected(handle, stream) {
  const reader = handle && handle.collected ? handle.collected[stream] : null
  if (!reader) return ''
  try {
    const chunk = reader.readFrom(0)
    if (chunk && typeof chunk.then === 'function') {
      return chunk.then((value) => (value && value.text) || '')
    }
    return (chunk && chunk.text) || ''
  } catch {
    return ''
  }
}

export async function runProcess(ctx, argv, options = {}) {
  const timeoutMs = options.timeoutMs || GIT_TIMEOUT_MS
  const subprocess = options.subprocess || resolveSubprocess(ctx)
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    throw new Error('harness subprocess service is unavailable; git mode cannot run git')
  }
  const baseSpec = {
    argv,
    // The harness subprocess service requires an absolute working directory.
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(options.env || {}) },
    graceMs: 4000,
  }
  const attempts = [
    { ...baseSpec, stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 262144 } } },
    { ...baseSpec, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } },
    baseSpec,
  ]
  let lastError = null
  for (const spec of attempts) {
    let handle
    try {
      handle = subprocess.spawn(spec)
    } catch (error) {
      lastError = error
      continue
    }
    let timer = null
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          handle.terminate()
        } catch {
          /* ignore */
        }
        reject(new Error(`git command timed out after ${Math.round(timeoutMs / 1000)}s: ${argv.slice(1, 3).join(' ')}`))
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([handle.done, guard])
      clearTimeout(timer)
      const stdout = await readCollected(handle, 'stdout')
      const stderr = await readCollected(handle, 'stderr')
      return {
        exitCode: typeof result?.exitCode === 'number' ? result.exitCode : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      }
    } catch (error) {
      clearTimeout(timer)
      lastError = error
      throw error
    }
  }
  throw lastError || new Error('spawn failed')
}

export function resolveSubprocess(ctx) {
  if (!ctx) return null
  try {
    if (ctx.subprocess && typeof ctx.subprocess.spawn === 'function') return ctx.subprocess
  } catch {
    /* fall through */
  }
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('subprocess')
      if (service && typeof service.spawn === 'function') return service
    }
  } catch {
    /* not ready */
  }
  return null
}

export async function resolveGit(ctx) {
  const subprocess = resolveSubprocess(ctx)
  if (subprocess && typeof subprocess.resolveExecutable === 'function') {
    try {
      const found = await subprocess.resolveExecutable('git')
      if (found) return found
    } catch {
      /* fall through */
    }
  }
  const candidates = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe']
  return candidates[0]
}

function trimOutput(text, max = 400) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export class GitTransport extends FolderTransport {
  constructor(ctx, settings, store) {
    const root = settings && settings.dir ? settings.dir : store ? path.join(store.gitRoot, 'repo') : ''
    super(root, { kind: 'git' })
    this.ctx = ctx
    this.settings = settings || {}
    this.store = store
    this.gitExe = null
  }

  describe() {
    const remote = this.settings.remote ? ` ↔ ${this.settings.remote}` : ''
    return `${this.root}${remote} (${this.settings.branch || 'main'})`
  }

  async git(args, options = {}) {
    if (!this.gitExe) this.gitExe = await resolveGit(this.ctx)
    const result = await runProcess(this.ctx, [this.gitExe, ...args], {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      env: options.env,
    })
    return result
  }

  async prepare() {
    const branch = this.settings.branch || 'main'
    const remote = this.settings.remote || ''
    if (!this.root) throw new Error('git directory is not configured')
    if (await pathExists(path.join(this.root, '.git'))) {
      return { created: false }
    }
    if (await pathExists(this.root)) {
      const entries = await fs.readdir(this.root)
      if (entries.length > 0) throw new Error(`git directory exists but is not a repository: ${this.root}`)
    }
    await ensureDir(path.dirname(this.root))
    if (remote) {
      const result = await this.git(['clone', '--quiet', remote, this.root], {
        cwd: path.dirname(this.root),
        timeoutMs: 240000,
      })
      if (result.exitCode !== 0) {
        throw new Error(`git clone failed: ${trimOutput(result.stderr || result.stdout)}`)
      }
    } else {
      await ensureDir(this.root)
      const init = await this.git(['init', '--quiet', this.root])
      if (init.exitCode !== 0) throw new Error(`git init failed: ${trimOutput(init.stderr)}`)
      const checkout = await this.git(['-C', this.root, 'checkout', '-B', branch])
      if (checkout.exitCode !== 0) throw new Error(`git checkout failed: ${trimOutput(checkout.stderr)}`)
    }
    return { created: true }
  }

  async test() {
    if (!this.root) return { ok: false, message: 'git directory is not configured' }
    try {
      await this.prepare()
      const branch = this.settings.branch || 'main'
      const inside = await this.git(['-C', this.root, 'rev-parse', '--is-inside-work-tree'])
      if (inside.exitCode !== 0) {
        return { ok: false, message: `not a git work tree: ${trimOutput(inside.stderr)}`, detail: this.root }
      }
      if (this.settings.remote) {
        const lsRemote = await this.git(['-C', this.root, 'ls-remote', '--heads', this.settings.remote, branch], {
          timeoutMs: 60000,
        })
        if (lsRemote.exitCode !== 0) {
          return {
            ok: false,
            message: `remote unreachable: ${trimOutput(lsRemote.stderr || lsRemote.stdout)}`,
            detail: this.settings.remote,
          }
        }
      }
      return {
        ok: true,
        message: this.settings.remote ? 'Git 仓库可访问 / git repository reachable' : '本地 Git 仓库就绪 / local git repository ready',
        detail: this.describe(),
      }
    } catch (error) {
      return { ok: false, message: messageOf(error), detail: this.root }
    }
  }

  async begin() {
    await this.prepare()
    const branch = this.settings.branch || 'main'
    await this.git(['-C', this.root, 'checkout', '-B', branch])
    if (this.settings.remote) {
      const pull = await this.git(['-C', this.root, 'pull', '--rebase', '--autostash', '--quiet', 'origin', branch], {
        timeoutMs: 120000,
      })
      if (pull.exitCode !== 0) {
        this.store?.log('warn', `git pull skipped: ${trimOutput(pull.stderr || pull.stdout)}`)
      }
    }
  }

  async end(context = {}) {
    const branch = this.settings.branch || 'main'
    const add = await this.git(['-C', this.root, 'add', '-A'])
    if (add.exitCode !== 0) throw new Error(`git add failed: ${trimOutput(add.stderr)}`)
    const message = `account-sync: ${context.deviceName || 'device'} ${new Date().toISOString()}`
    const commit = await this.git([
      '-C',
      this.root,
      '-c',
      'user.name=DSH Account Sync',
      '-c',
      'user.email=account-sync@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      message,
    ])
    if (commit.exitCode !== 0) {
      const text = trimOutput(`${commit.stderr} ${commit.stdout}`)
      if (!/nothing to commit|no changes added/i.test(text)) {
        throw new Error(`git commit failed: ${text}`)
      }
    }
    if (!this.settings.remote) return { pushed: false }
    let push = await this.git(['-C', this.root, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], {
      timeoutMs: 180000,
    })
    if (push.exitCode !== 0) {
      const pull = await this.git(['-C', this.root, 'pull', '--rebase', '--autostash', '--quiet', 'origin', branch], {
        timeoutMs: 120000,
      })
      if (pull.exitCode === 0) {
        push = await this.git(['-C', this.root, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], {
          timeoutMs: 180000,
        })
      }
    }
    if (push.exitCode !== 0) {
      throw new Error(`git push failed: ${trimOutput(push.stderr || push.stdout)}`)
    }
    return { pushed: true }
  }
}

export default GitTransport
