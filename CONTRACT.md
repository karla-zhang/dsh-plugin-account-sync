# Account Sync — Host ↔ Web UI contract (v1)

The Host half (`index.js` + `lib/*.js`) owns all state and network/fs work. The browser half
(`client.js`) is a plain settings section that talks to the Host over same-origin JSON endpoints.
Everything the UI renders comes from these endpoints; the UI never touches the transport itself.

Every route below is the full path under the DSH web origin. All POST bodies are JSON (`content-type: application/json`), all responses are JSON.

## Routes

| Method + path | Body | Response |
| --- | --- | --- |
| `GET /account-sync/api/status` | — | `StatusResponse` |
| `POST /account-sync/api/config` | partial `SyncConfig` (secrets as strings) | `{ ok, config: PublicConfig }` |
| `POST /account-sync/api/test` | `{}` (uses saved config) | `{ ok, message, detail?, urls?, tokenSet?, pairing? }` |
| `POST /account-sync/api/peers` | `{}` | `{ ok, peers: Peer[] }` |
| `POST /account-sync/api/plan` | `{ categories?: string[] }` | `{ ok, plan: Plan }` |
| `POST /account-sync/api/sync` | `{ categories?: string[] }` | `{ ok, report: Report }` |
| `POST /account-sync/api/log` | `{ limit?: number }` | `{ ok, lines: LogLine[] }` |
| `POST /account-sync/api/open` | `{ target: 'data' \| 'transport' }` | `{ ok, message }` |
| `POST /account-sync/api/reset` | `{ what: 'state' }` | `{ ok }` |

`GET /account-sync/api/status` is polled by the UI (2–3 s) while mounted; other calls are on demand.
The Host serialises `/sync` and `/plan`: concurrent calls return `{ ok: false, busy: true }` with
HTTP 409.

When the saved transport is `lan` with `role: 'host'` and the host is running, a successful `/test`
additionally returns `urls` (the reachable `http://<ip>:<port>/_account-sync` bases) and `tokenSet`,
and its `detail` embeds the pairing line `配对信息 / pairing · <urls> · token: <token>`. That token is
only shown through this same-origin route so the operator can pair the other device; it is never part
of `PublicConfig` nor of the data published to the transport.

## SyncConfig (saved in the Host, secrets in the credentials store)

```ts
interface SyncConfig {
  transport: 'off' | 'folder' | 'git' | 'webdav' | 'lan'
  deviceName: string                    // user-visible name for this terminal
  folder: { path: string }              // folder transport: shared cloud folder root
  git: { dir: string; remote: string; branch: string }   // dir = local clone/worktree
  webdav: { url: string; username: string; password?: string } // password write-only
  lan: { role: 'host' | 'client'; port: number; bind: string; url: string; token?: string } // host: token = access token this host requires; client: token to present, url of host
  categories: { plugins: boolean; settings: boolean; workspaces: boolean; sessions: boolean; skills: boolean }
  workspacePaths: string[] | null        // null = every registered workspace
  excludes: string[]                     // additional exclude globs on top of the built-in set
  autoSync: { enabled: boolean; intervalMs: number }
  autoApplyPlugins: boolean              // install missing bundles pulled from peers
}
```

`PublicConfig` = the same shape, with `password`/`token` replaced by `passwordSet`/`tokenSet`
booleans and every absolute path kept as-is. The UI sends a partial object on `POST /config`;
omitting a secret field keeps the stored secret, sending `""` clears it.

## Data on the transport (layout shared by every transport)

```
<root>/devices/<deviceId>/
  device.json          { deviceId, name, hostname, platform, userId, appVersion, updatedAt }
  plugins.json         { generatedAt, bundles: BundleRecord[] }
  settings.json        { generatedAt, entries: [{ ns, value }] }     // secrets stripped
  workspaces/<wsKey>/
    manifest.json      { key, path, scannedAt, files: { <relPath>: { hash, size, mtime } } }
    blobs/<sha256>     file bytes, content addressed
  sessions/<wsKey>/<sessionId>/<relative session files>              // zstd jsonl, additive
  skills/<kind>/<name>/...                                            // skills + agent presets
  sync-state.json      { applied: <peerId> → { <category>: fingerprint } }
```

`<root>` for `folder` is `config.folder.path`; for `git` it is the cloned repo dir; for `webdav`
it is the remote root; for `lan` it is the peer Host's data root served over HTTP.

## Response types

```ts
interface DeviceInfo { id: string; name: string; hostname: string; platform: string; userId: string | null; appVersion: string }
interface LogLine { at: string; level: 'info' | 'warn' | 'error'; text: string }
interface CategoryCount { enabled: boolean; label: string; summary: string; count?: number }
interface Peer {
  deviceId: string; name: string; hostname: string; platform: string
  userId: string | null; sameAccount: boolean; isSelf: boolean
  updatedAt: string; categories: { plugins: number; settings: number; workspaces: number; sessions: number; skills: number }
  reachable: boolean
}
interface StatusResponse {
  ok: boolean
  version: string
  busy: boolean
  device: DeviceInfo
  account: { signedIn: boolean; userId: string | null; name: string | null }
  transport: { kind: SyncConfig['transport']; configured: boolean; ok: boolean | null; message: string }
  config: PublicConfig
  categories: Record<'plugins' | 'settings' | 'workspaces' | 'sessions' | 'skills', CategoryCount>
  peers: Peer[]
  lastSync: null | { at: string; ok: boolean; report: Report }
  log: LogLine[]
}
interface PlanItem { id: string; category: string; peer: string; title: string; detail: string; action: string }
interface Plan { generatedAt: string; peers: Peer[]; items: PlanItem[]; conflicts: PlanItem[] }
interface Report {
  startedAt: string; finishedAt: string
  transport: string
  pushed: { plugins: boolean; settings: boolean; workspaces: { files: number }; sessions: { files: number }; skills: { files: number } }
  pulled: { workspaceFiles: number; sessionFiles: number; skillFiles: number }
  applied: {
    pluginInstalls: { name: string; version?: string; ok: boolean; message: string }[]
    pluginStates: { name: string; enabled: boolean; ok: boolean; message: string }[]
    settings: { ns: string; ok: boolean; message: string }[]
  }
  conflicts: { category: string; path: string; peer: string; savedAs?: string }[]
  errors: { category: string; message: string }[]
  peers: string[]
}
```

## Behaviour the UI can rely on

- `POST /sync` always publishes this device's snapshot first (when the category is enabled and the
  transport is configured), then reads every other device's directory and applies what is safe:
  missing plugins (only when `autoApplyPlugins`), enable/disable bits, non-secret settings values,
  workspace files (three-way by content hash; conflicting local copies are preserved and a
  `<name>.sync-conflict-<peer>-<stamp><ext>` copy is written), missing session logs (verbatim
  copies, never overwriting a local session log) and skill/preset files (same conflict rule).
- Deletions never propagate.
- `POST /plan` performs the same scan without writing or applying anything; conflicts are listed.
- The Host keeps its own state under `<DSH_HOME>/account-sync/` (`config.json`, `state.json`,
  `log.ndjson`, `git/`, `lan/`); nothing of it is written to the workspace.
- Passwords/tokens live in the Host credentials store (`account-sync-webdav`, `account-sync-lan`,
  `account-sync-lan-host` record keys) and are never returned by any endpoint.
- Every mutation appends to `log.ndjson` and to the in-memory ring buffer returned by `/status`.
