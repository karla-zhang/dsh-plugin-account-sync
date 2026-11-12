# Account Sync

[中文说明](README.zh.md)

A DeepSeek Harness plugin that keeps **the same account's terminals in sync**: installed plugins and
their enablement, app settings, selected workspace files, session logs, and skills / agent presets.

There is no server-side account store in DSH today (sessions are only uploaded one way for model
context), so this plugin syncs through a transport you control. Four transports are built in and all
of them are options, not defaults:

| Transport | What it needs | Best for |
| --- | --- | --- |
| **Folder** | a folder shared by both machines (Baidu Netdisk / OneDrive / Syncthing / a network share) | the simplest setup; the cloud client moves the bytes |
| **Git** | a git remote both machines can reach | history, auditable diffs, manual conflict handling |
| **WebDAV** | any WebDAV endpoint (Nextcloud, Jianguoyun, NAS…) | machines that are never online at the same time |
| **LAN** | one machine acts as host on a port; the other connects | fast local sync without a cloud account |

Every content category is an independent toggle, and the page includes a dry-run **Plan** before a
real **Sync**.

## Install

1. Open **Settings → Plugins** (or the plugin market) and install the bundle from the local package
   directory: `plugin_manager` → `install_bundle` with `target` pointing at this folder, or the
   Profile → Plugins page's "install from folder".
2. Restart the terminal if DSH asks for it, then open **Settings → Account Sync**.
3. Pick a transport, fill in its fields, press **Test**, then **Sync now** (or **Plan** first).
4. Add `autoSync` if the machine should sync on its own on a timer.

Cross-device layout: each device publishes under `<root>/devices/<deviceId>/`; every device reads the
other device directories. No two devices ever write the same file. Deletions never propagate, session
logs are imported only when missing (append-only logs are never overwritten), and conflicting
workspace/skill files keep both sides (`name.sync-conflict-<peer>-<stamp>.ext`).

Pairing the **LAN** transport: on the host machine set role `host`, press **Test**, and copy the pairing
line it shows (`配对信息 / pairing · http://<lan-ip>:47810/_account-sync · token: …`). The host token
lives in the credentials store and is shown only by that same-origin test call. On the client machine
set role `client`, paste the URL and token, then **Test**.

## Data & safety

- Plugin configuration, sync state and logs live in `<DSH_HOME>/account-sync/`; nothing is written to
  the workspace except the synchronized files themselves.
- WebDAV passwords and LAN tokens live in the DSH credentials store (records
  `account-sync-webdav`, `account-sync-lan`, `account-sync-lan-host`) and are never returned by the
  HTTP API.
- Secret settings are stripped before publishing: settings values are read with
  `redactSecrets: true`, and any key that looks like a token/password/secret is removed from
  `cordis.patch.yml` overrides as well.
- Official `@deepseek-ai/*` bundles are never installed by the sync; only missing non-official
  bundles are installed, and only when **Install missing plugins** is on.
- Workspace files are opt-in. When the toggle is on, all registered workspaces are synced unless a
  subset is selected. Default ignore rules cover `node_modules`, `.git`, virtualenvs, caches, `dist`,
  `build`, conflict copies and temp files; extra globs can be added.
- Session logs sync for every registered workspace, independent of the workspace-file toggle: a
  session-only setup still exchanges histories. Existing local logs are never overwritten.
- Transport data is stored in plain form in the folder/repository you choose; encryption and access
  control are whatever that transport provides (cloud-drive permissions, Git remote auth, WebDAV
  credentials, LAN token). Secrets are stripped before publishing, but app settings and workspace
  files are not additionally encrypted by the plugin.
- Local-path bundles (`link:` or an absolute folder in the source field) can only be installed on a
  machine where that path exists; registry bundles are installed by name. Failures are reported per
  bundle and never abort the whole sync.
- A sync is serialized: a second request while one is running returns HTTP 409 `{busy:true}`.

## Troubleshooting

- **"transport not configured"** — the selected transport needs its address/path first.
- **Git errors** — the plugin shells out through the host subprocess service and falls back to
  `C:\Program Files\Git\cmd\git.exe`. Make sure `git ls-remote <remote>` works in a normal terminal.
- **LAN test fails** — the port may be blocked by Windows Firewall; allow DSH/node on the private
  network, or change the port.
- **Nothing to pull** — a peer only appears after it has published at least once (`Sync now` on it).
- **Different account** — peers whose `userId` differs from this terminal's account are listed but
  never applied.

## Development

Host: `index.js`, `lib/*.js` (plain Node ESM, `node --check` clean). Web UI: `client.js` (plain
browser script for `window.__ModuleLoader__.load`, no bundler). Contract: [CONTRACT.md](CONTRACT.md).
Version: 0.1.0.
