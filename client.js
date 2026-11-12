/* Plugin Account Sync — browser half of the DSH Web UI plugin.
 * Contract: ./CONTRACT.md v1. Plain browser script loaded by window.__ModuleLoader__;
 * React 18 via require('react'); no JSX, no bundler, no package imports.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-account-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const ZH = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase().startsWith('zh');
    const t = (zh, en) => (ZH ? zh : en);

    const API_BASE = '/account-sync/api';
    const STATUS_POLL_MS = 2500;
    const LOG_LIMIT = 80;
    const NOTICE_MS = 7000;
    const MAX_PLAN_ITEMS = 100;
    const MAX_REPORT_ROWS = 24;

    const TRANSPORT_IDS = ['off', 'folder', 'git', 'webdav', 'lan'];
    const TRANSPORT_LABEL = {
      off: t('关闭', 'Off'),
      folder: t('共享文件夹', 'Shared folder'),
      git: t('Git 仓库', 'Git repository'),
      webdav: 'WebDAV',
      lan: t('局域网直连', 'LAN direct'),
    };
    const LAN_ROLE_LABEL = { host: t('主机', 'Host'), client: t('客户端', 'Client') };
    const CATEGORY_IDS = ['plugins', 'settings', 'workspaces', 'sessions', 'skills'];
    const CATEGORY_LABEL = {
      plugins: t('插件', 'Plugins'),
      settings: t('设置', 'Settings'),
      workspaces: t('工作区', 'Workspaces'),
      sessions: t('会话', 'Sessions'),
      skills: t('技能', 'Skills'),
    };
    const CATEGORY_DEFS = [
      { id: 'plugins', label: t('插件与启用状态', 'Plugins & enable state'), desc: t('插件包以及每个插件的启用/停用开关。', 'Plugin bundles plus each plugin’s enabled flag.') },
      { id: 'settings', label: t('应用设置', 'App settings'), desc: t('非机密的应用设置项，密钥会被剥离。', 'Non-secret app settings; secrets are stripped.') },
      { id: 'workspaces', label: t('工作区文件', 'Workspace files'), desc: t('按内容哈希做三方合并，冲突时保留本地副本。', 'Three-way merge by content hash; conflicts keep a local copy.') },
      { id: 'sessions', label: t('会话记录', 'Session logs'), desc: t('只增不改地复制缺失的会话日志。', 'Copies missing session logs additively, never overwriting.') },
      { id: 'skills', label: t('技能与预设', 'Skills & presets'), desc: t('技能与 agent 预设文件，同样保留冲突副本。', 'Skill and agent preset files, with conflict copies.') },
    ];
    const INTERVAL_OPTIONS = [
      { value: 60000, label: t('1 分钟', '1 min') },
      { value: 300000, label: t('5 分钟', '5 min') },
      { value: 900000, label: t('15 分钟', '15 min') },
      { value: 1800000, label: t('30 分钟', '30 min') },
    ];
    const INTERVAL_VALUES = [60000, 300000, 900000, 1800000];
    const LEVELS = ['info', 'warn', 'error'];
    const LEVEL_LABEL = { info: t('信息', 'info'), warn: t('警告', 'warn'), error: t('错误', 'error') };
    const ACTION_LABEL = {
      create: t('新增', 'add'), update: t('更新', 'update'), delete: t('删除', 'delete'),
      conflict: t('冲突', 'conflict'), skip: t('跳过', 'skip'), pull: t('拉取', 'pull'),
      push: t('推送', 'push'), install: t('安装', 'install'), enable: t('启用', 'enable'),
      disable: t('停用', 'disable'),
    };

    /* ------------------------------------------------------------------ data helpers */
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    const arr = (v) => (Array.isArray(v) ? v : []);
    const txt = (v) => (v === null || v === undefined ? '' : String(v));
    const str = (v, fb) => (v === null || v === undefined || v === '' ? (fb === undefined ? '—' : fb) : String(v));
    const bool = (v, fb) => (v === true ? true : v === false ? false : !!fb);
    const numOf = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
    const numText = (v) => { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n)) : '0'; };
    const portOf = (v) => {
      const s = txt(v).trim();
      const n = s === '' ? NaN : Number(s);
      return Number.isFinite(n) && n >= 1 && n <= 65535 ? Math.floor(n) : 47810;
    };
    const flagText = (v) => (v === true ? t('是', 'yes') : v === false ? t('否', 'no') : '—');
    const oneLine = (v, max) => {
      const s = txt(v).replace(/\s+/g, ' ').trim();
      return s.length > max ? s.slice(0, max - 1) + '…' : s;
    };
    const pad2 = (n) => (n < 10 ? '0' + n : String(n));
    const toDate = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
      return isNaN(d.getTime()) ? null : d;
    };
    const fmtClock = (v) => {
      const d = toDate(v);
      return d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) : '—';
    };
    const fmtDateTime = (v) => {
      const d = toDate(v);
      if (!d) return '—';
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + fmtClock(d);
    };
    const fmtRel = (v) => {
      const d = toDate(v);
      if (!d) return '—';
      const s = Math.floor(Math.max(0, Date.now() - d.getTime()) / 1000);
      if (s < 60) return t(s + ' 秒前', s + 's ago');
      const m = Math.floor(s / 60);
      if (m < 60) return t(m + ' 分钟前', m + 'm ago');
      const hh = Math.floor(m / 60);
      return hh < 24 ? t(hh + ' 小时前', hh + 'h ago') : t(Math.floor(hh / 24) + ' 天前', Math.floor(hh / 24) + 'd ago');
    };
    const durationBetween = (a, b) => {
      const start = toDate(a), end = toDate(b);
      if (!start || !end) return '';
      const ms = end.getTime() - start.getTime();
      if (!Number.isFinite(ms) || ms < 0) return '';
      const s = Math.round(ms / 1000);
      if (s < 60) return t(s + ' 秒', s + 's');
      const m = Math.floor(s / 60);
      if (m < 60) return t(m + ' 分 ' + (s % 60) + ' 秒', m + 'm ' + (s % 60) + 's');
      return t(Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分', Math.floor(m / 60) + 'h ' + (m % 60) + 'm');
    };
    const truncateId = (v) => {
      const s = txt(v);
      if (!s) return '—';
      return s.length > 18 ? s.slice(0, 10) + '…' + s.slice(-4) : s;
    };
    const errText = (e) => {
      if (!e) return t('未知错误', 'Unknown error');
      if (typeof e === 'string') return e;
      if (typeof e.message === 'string' && e.message) return e.message;
      return String(e);
    };
    const msgOf = (res) => {
      const data = obj(res && res.data);
      if (typeof data.message === 'string' && data.message) return data.message;
      if (typeof data.error === 'string' && data.error) return data.error;
      const status = res && res.status ? res.status : '?';
      const statusText = res && res.statusText ? ' ' + res.statusText : '';
      return 'HTTP ' + status + statusText;
    };
    const busyMessage = () => t('同步或扫描正在进行，请稍后再试。', 'A sync or scan is already running; try again shortly.');
    const isBusyResponse = (res) => !!res && (res.status === 409 || obj(res.data).busy === true);
    const categoryLabel = (id) => CATEGORY_LABEL[id] || str(id);
    const catRank = (id) => { const i = CATEGORY_IDS.indexOf(id); return i >= 0 ? i : 99; };
    const actionLabel = (v) => ACTION_LABEL[v] || str(v);
    const actionTone = (v) => (v === 'conflict' ? 'warn' : v === 'create' || v === 'add' || v === 'install' ? 'ok' : null);

    async function requestJson(method, path, body) {
      const headers = { accept: 'application/json' };
      const init = { method, headers, cache: 'no-store', credentials: 'same-origin' };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(API_BASE + path, init);
      let data = null;
      try { data = await res.json(); } catch (err) { data = null; }
      return { status: res.status, statusText: res.statusText || '', ok: res.ok, data };
    }

    /* ------------------------------------------------------------------ form helpers */
    function cloneForm(form) {
      return {
        transport: form.transport,
        deviceName: form.deviceName,
        folder: { path: form.folder.path },
        git: { dir: form.git.dir, remote: form.git.remote, branch: form.git.branch },
        webdav: {
          url: form.webdav.url, username: form.webdav.username, password: form.webdav.password,
          passwordSet: form.webdav.passwordSet, clearPassword: form.webdav.clearPassword,
        },
        lan: {
          role: form.lan.role, port: form.lan.port, bind: form.lan.bind, url: form.lan.url,
          token: form.lan.token, tokenSet: form.lan.tokenSet, clearToken: form.lan.clearToken,
        },
        categories: {
          plugins: form.categories.plugins, settings: form.categories.settings,
          workspaces: form.categories.workspaces, sessions: form.categories.sessions,
          skills: form.categories.skills,
        },
        workspacePaths: form.workspacePaths === null ? null : form.workspacePaths.slice(),
        autoSync: { enabled: form.autoSync.enabled, intervalMs: form.autoSync.intervalMs },
        autoApplyPlugins: form.autoApplyPlugins,
      };
    }

    function formFromConfig(config) {
      const c = obj(config);
      const folder = obj(c.folder);
      const git = obj(c.git);
      const webdav = obj(c.webdav);
      const lan = obj(c.lan);
      const cats = obj(c.categories);
      const auto = obj(c.autoSync);
      const interval = numOf(auto.intervalMs, 300000);
      return {
        transport: TRANSPORT_IDS.indexOf(c.transport) >= 0 ? c.transport : 'off',
        deviceName: txt(c.deviceName),
        folder: { path: txt(folder.path) },
        git: { dir: txt(git.dir), remote: txt(git.remote), branch: txt(git.branch) },
        webdav: {
          url: txt(webdav.url), username: txt(webdav.username), password: '',
          passwordSet: webdav.passwordSet === true, clearPassword: false,
        },
        lan: {
          role: lan.role === 'client' ? 'client' : 'host',
          port: lan.port === null || lan.port === undefined || lan.port === '' ? '' : String(lan.port),
          bind: txt(lan.bind), url: txt(lan.url),
          token: '', tokenSet: lan.tokenSet === true, clearToken: false,
        },
        categories: {
          plugins: bool(cats.plugins, true), settings: bool(cats.settings, true),
          workspaces: bool(cats.workspaces, true), sessions: bool(cats.sessions, true),
          skills: bool(cats.skills, true),
        },
        workspacePaths: Array.isArray(c.workspacePaths)
          ? c.workspacePaths.filter((entry) => typeof entry === 'string' && entry)
          : null,
        autoSync: { enabled: bool(auto.enabled, false), intervalMs: INTERVAL_VALUES.indexOf(interval) >= 0 ? interval : 300000 },
        autoApplyPlugins: bool(c.autoApplyPlugins, false),
      };
    }

    function payloadFromForm(form) {
      const out = {
        transport: form.transport,
        deviceName: form.deviceName,
        folder: { path: form.folder.path },
        git: { dir: form.git.dir, remote: form.git.remote, branch: form.git.branch },
        webdav: { url: form.webdav.url, username: form.webdav.username },
        lan: { role: form.lan.role, port: portOf(form.lan.port), bind: form.lan.bind, url: form.lan.url },
        categories: {
          plugins: form.categories.plugins === true, settings: form.categories.settings === true,
          workspaces: form.categories.workspaces === true, sessions: form.categories.sessions === true,
          skills: form.categories.skills === true,
        },
        workspacePaths: form.workspacePaths === null ? null : form.workspacePaths.slice(),
        autoSync: { enabled: form.autoSync.enabled === true, intervalMs: numOf(form.autoSync.intervalMs, 300000) },
        autoApplyPlugins: form.autoApplyPlugins === true,
      };
      if (form.webdav.password) out.webdav.password = form.webdav.password;
      else if (form.webdav.clearPassword && form.webdav.passwordSet) out.webdav.password = '';
      if (form.lan.token) out.lan.token = form.lan.token;
      else if (form.lan.clearToken && form.lan.tokenSet) out.lan.token = '';
      return out;
    }

    function workspacesOf(status, config) {
      const cats = obj(obj(status).categories);
      const category = obj(cats.workspaces);
      const raw = Array.isArray(category.list)
        ? category.list
        : Array.isArray(obj(config).workspacePaths)
          ? obj(config).workspacePaths
          : [];
      const out = [];
      const seen = {};
      for (const entry of raw) {
        const item = typeof entry === 'string' ? { path: entry, key: entry } : obj(entry);
        const path = txt(item.path) || txt(item.name) || txt(item.key);
        if (!path || seen[path]) continue;
        seen[path] = true;
        out.push({ path, key: txt(item.key) || path });
      }
      for (const entry of arr(obj(config).workspacePaths)) {
        if (typeof entry === 'string' && entry && !seen[entry]) {
          seen[entry] = true;
          out.push({ path: entry, key: entry });
        }
      }
      return out;
    }

    /* ------------------------------------------------------------------ primitives */
    function Dot(props) {
      return h('span', { className: 'acs-dot acs-dot-' + (props.tone || 'idle'), 'aria-hidden': 'true' });
    }
    function Chip(props) {
      return h('span', { className: 'acs-chip' + (props.tone ? ' acs-chip-' + props.tone : '') }, props.children);
    }
    function Button(props) {
      const busy = !!props.busy;
      return h('button', {
        type: 'button',
        className: 'acs-btn' + (props.kind ? ' acs-btn-' + props.kind : ''),
        disabled: busy || !!props.disabled,
        title: props.title || undefined,
        onClick: props.onClick,
      }, busy ? h('span', { className: 'acs-spin', 'aria-hidden': 'true' }) : null,
        h('span', null, props.label || ''));
    }
    function Section(props) {
      return h('section', { className: 'acs-section' },
        h('div', { className: 'acs-sec-head' },
          h('h3', { className: 'acs-sec-title' }, props.title),
          props.hint ? h('span', { className: 'acs-hint' }, props.hint) : null,
          props.actions ? h('div', { className: 'acs-sec-actions' }, props.actions) : null),
        h('div', { className: 'acs-sec-body' }, props.children));
    }
    function Fact(props) {
      return h('div', { className: 'acs-fact' },
        h('span', { className: 'acs-fact-key' }, props.label),
        h('span', { className: 'acs-fact-val' }, props.children));
    }
    function Toggle(props) {
      return h('label', { className: 'acs-toggle' },
        h('input', {
          type: 'checkbox', checked: !!props.checked, disabled: !!props.disabled,
          onChange: (event) => { if (typeof props.onChange === 'function') props.onChange(event.target.checked); },
        }),
        h('span', { className: 'acs-toggle-text' },
          h('span', { className: 'acs-toggle-label' }, props.label),
          props.desc ? h('span', { className: 'acs-toggle-desc' }, props.desc) : null));
    }
    function TextField(props) {
      return h('label', { className: 'acs-field' },
        h('span', { className: 'acs-field-label' }, props.label),
        h('input', {
          className: 'acs-input' + (props.mono ? ' acs-mono' : ''),
          type: props.type || 'text',
          value: props.value === null || props.value === undefined ? '' : String(props.value),
          placeholder: props.placeholder || '',
          disabled: !!props.disabled,
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event) => { if (typeof props.onChange === 'function') props.onChange(event.target.value); },
        }),
        props.hint ? h('span', { className: 'acs-field-hint' }, props.hint) : null);
    }
    function SelectField(props) {
      return h('label', { className: 'acs-field' },
        h('span', { className: 'acs-field-label' }, props.label),
        h('select', {
          className: 'acs-input',
          value: props.value,
          disabled: !!props.disabled,
          onChange: (event) => { if (typeof props.onChange === 'function') props.onChange(event.target.value); },
        }, arr(props.options).map((option) => h('option', { key: option.value, value: option.value }, option.label))),
        props.hint ? h('span', { className: 'acs-field-hint' }, props.hint) : null);
    }
    function SecretField(props) {
      return h('div', { className: 'acs-field' },
        h('label', { className: 'acs-field-label' }, props.label,
          props.saved ? h('span', { className: 'acs-hint' }, ' ' + t('（已保存）', '(saved)')) : null),
        h('input', {
          className: 'acs-input', type: 'password', value: props.value || '',
          autoComplete: 'new-password',
          placeholder: props.saved ? t('留空保持不变', 'Leave blank to keep') : '',
          onChange: (event) => { if (typeof props.onChange === 'function') props.onChange(event.target.value); },
        }),
        props.saved ? h('label', { className: 'acs-toggle acs-toggle-inline' },
          h('input', {
            type: 'checkbox', checked: !!props.clearing,
            onChange: (event) => { if (typeof props.onClearToggle === 'function') props.onClearToggle(event.target.checked); },
          }),
          h('span', { className: 'acs-toggle-desc' }, t('保存时清除已存密码/令牌', 'Clear the saved password/token on save'))) : null);
    }
    function ListBlock(props) {
      return h('div', { className: 'acs-sublist' },
        h('div', { className: 'acs-subhead' }, props.title),
        arr(props.rows).map((row) => h('div', { key: row.key, className: 'acs-subrow' },
          h(Dot, { tone: row.tone || 'idle' }),
          h('span', { className: 'acs-subrow-main' }, row.main),
          row.extra ? h('span', { className: 'acs-chip' }, row.extra) : null,
          row.message ? h('span', { className: 'acs-dim acs-subrow-msg' }, row.message) : null)));
    }
    function WarnBox(props) {
      return h('div', { className: 'acs-warnbox' },
        h('div', { className: 'acs-warnbox-title' }, props.title),
        arr(props.rows).map((row) => h('div', { key: row.key, className: 'acs-warnrow' },
          h('span', { className: 'acs-warnrow-main' }, row.main),
          row.extra ? h('span', { className: 'acs-dim' }, row.extra) : null,
          row.message ? h('span', { className: 'acs-dim acs-mono acs-warnrow-msg' }, row.message) : null)));
    }

    /* ------------------------------------------------------------------ sections */
    function StatusSection(props) {
      const status = obj(props.status);
      const device = obj(status.device);
      const account = obj(status.account);
      const transport = obj(status.transport);
      const last = status.lastSync && typeof status.lastSync === 'object' ? status.lastSync : null;
      const deviceId = txt(device.id);
      const transportId = TRANSPORT_IDS.indexOf(transport.kind) >= 0 ? transport.kind : null;
      const transportTone = transport.ok === true ? 'ok' : transport.ok === false ? 'error' : 'idle';
      const accountText = account.signedIn ? (txt(account.name) || txt(account.userId) || t('已登录', 'Signed in')) : t('未登录', 'Not signed in');
      const lastSyncText = last ? fmtDateTime(last.at) : t('从未同步', 'Never synced');
      return h(Section, {
        title: t('状态', 'Status'),
        hint: status.version ? 'v' + txt(status.version) : null,
        actions: [
          status.busy
            ? h('span', { key: 'busy', className: 'acs-busy-line' }, h('span', { className: 'acs-spin' }), t('宿主同步中…', 'Host syncing…'))
            : null,
          h(Button, { key: 'refresh', label: t('刷新', 'Refresh'), kind: 'ghost', busy: props.refreshing, onClick: props.onRefresh }),
          h(Button, { key: 'sync', label: t('立即同步', 'Sync now'), kind: 'primary', busy: props.syncing || status.busy === true, onClick: props.onSync }),
        ],
      },
      h('div', { className: 'acs-facts' },
        h(Fact, { label: t('设备名称', 'Device name') }, h('span', null, txt(device.name) || t('未命名', 'Unnamed'))),
        h(Fact, { label: t('设备 ID', 'Device ID') },
          h('code', { className: 'acs-mono acs-device-id', title: deviceId }, truncateId(deviceId)),
          deviceId ? h('button', { type: 'button', className: 'acs-linkbtn', onClick: () => props.onCopy(deviceId) }, t('复制', 'Copy')) : null),
        h(Fact, { label: t('登录账户', 'Signed-in account') },
          h('span', null, accountText),
          account.signedIn && txt(account.userId) && txt(account.name) ? h('span', { className: 'acs-dim acs-mono' }, txt(account.userId)) : null),
        h(Fact, { label: t('传输方式', 'Transport') },
          h(Dot, { tone: transportTone }),
          h('span', null, transportId ? TRANSPORT_LABEL[transportId] : str(transport.kind)),
          h('span', { className: 'acs-dim' }, transport.configured ? t('已配置', 'configured') : t('未配置', 'not configured'))),
        h(Fact, { label: t('上次同步', 'Last sync') },
          h('span', null, lastSyncText),
          last ? h(Chip, { tone: last.ok === true ? 'ok' : 'error' }, last.ok === true ? t('成功', 'success') : t('失败', 'failed')) : null)),
      transport.message ? h('div', { className: 'acs-dim acs-transport-msg' }, oneLine(transport.message, 280)) : null);
    }

    function ConnectionSection(props) {
      const form = props.form;
      const transport = form.transport;
      const result = props.testResult;
      const fields = [
        h(TextField, {
          key: 'name', label: t('设备名称', 'Device name'), value: form.deviceName,
          placeholder: t('例如：办公室台式机', 'e.g. Office desktop'),
          onChange: (v) => props.onChange(['deviceName'], v),
        }),
        h(SelectField, {
          key: 'transport', label: t('传输方式', 'Transport'), value: transport,
          options: TRANSPORT_IDS.map((id) => ({ value: id, label: TRANSPORT_LABEL[id] })),
          onChange: (v) => props.onChange(['transport'], v),
        }),
      ];
      let details = null;
      if (transport === 'folder') {
        details = h('div', { className: 'acs-fields' },
          h(TextField, {
            label: t('共享文件夹路径', 'Shared folder path'), value: form.folder.path, mono: true,
            placeholder: 'D:\\Sync\\dsh-account', onChange: (v) => props.onChange(['folder', 'path'], v),
          }),
          h('span', { className: 'acs-field-hint' }, t('所有设备都指向同一个云盘文件夹。', 'Every device points at the same cloud-drive folder.')));
      } else if (transport === 'git') {
        details = h('div', { className: 'acs-fields' },
          h(TextField, {
            label: t('本地仓库目录', 'Local repository directory'), value: form.git.dir, mono: true,
            placeholder: 'D:\\Sync\\dsh-repo', onChange: (v) => props.onChange(['git', 'dir'], v),
          }),
          h(TextField, {
            label: t('远程地址', 'Remote URL'), value: form.git.remote, mono: true,
            placeholder: 'git@github.com:you/dsh-sync.git', onChange: (v) => props.onChange(['git', 'remote'], v),
          }),
          h(TextField, {
            label: t('分支', 'Branch'), value: form.git.branch, mono: true,
            placeholder: 'main', onChange: (v) => props.onChange(['git', 'branch'], v),
          }));
      } else if (transport === 'webdav') {
        details = h('div', { className: 'acs-fields' },
          h(TextField, {
            label: t('WebDAV 地址', 'WebDAV URL'), value: form.webdav.url, mono: true,
            placeholder: 'https://dav.example.com/dsh', onChange: (v) => props.onChange(['webdav', 'url'], v),
          }),
          h(TextField, {
            label: t('用户名', 'Username'), value: form.webdav.username,
            onChange: (v) => props.onChange(['webdav', 'username'], v),
          }),
          h(SecretField, {
            label: t('密码', 'Password'), value: form.webdav.password, saved: form.webdav.passwordSet,
            clearing: form.webdav.clearPassword,
            onChange: (v) => props.onChange(['webdav', 'password'], v),
            onClearToggle: (v) => props.onChange(['webdav', 'clearPassword'], v),
          }));
      } else if (transport === 'lan') {
        details = h('div', { className: 'acs-fields' },
          h(SelectField, {
            label: t('角色', 'Role'), value: form.lan.role,
            options: [{ value: 'host', label: LAN_ROLE_LABEL.host }, { value: 'client', label: LAN_ROLE_LABEL.client }],
            onChange: (v) => props.onChange(['lan', 'role'], v),
          }),
          h(TextField, {
            label: t('端口', 'Port'), type: 'number', value: form.lan.port, placeholder: '47810',
            onChange: (v) => props.onChange(['lan', 'port'], v),
          }),
          form.lan.role === 'host'
            ? h(TextField, {
              label: t('绑定地址', 'Bind address'), value: form.lan.bind, mono: true,
              placeholder: '0.0.0.0', onChange: (v) => props.onChange(['lan', 'bind'], v),
            })
            : h(TextField, {
              label: t('主机地址', 'Host URL'), value: form.lan.url, mono: true,
              placeholder: 'http://192.168.1.10:47810', onChange: (v) => props.onChange(['lan', 'url'], v),
            }),
          h(SecretField, {
            label: form.lan.role === 'host' ? t('访问令牌', 'Access token') : t('令牌', 'Token'),
            value: form.lan.token, saved: form.lan.tokenSet, clearing: form.lan.clearToken,
            onChange: (v) => props.onChange(['lan', 'token'], v),
            onClearToggle: (v) => props.onChange(['lan', 'clearToken'], v),
          }));
      } else {
        details = h('div', { className: 'acs-dim' }, t('已关闭：不会与任何设备同步数据。', 'Off: no data is shared with any device.'));
      }
      return h(Section, {
        title: t('连接', 'Connection'),
        hint: t('选择设备之间共享数据的方式。', 'How this device shares data with peers.'),
        actions: props.dirty ? h(Chip, { tone: 'warn' }, t('未保存', 'unsaved')) : null,
      },
      h('div', { className: 'acs-fields' }, fields),
      details,
      h('div', { className: 'acs-btnrow' },
        h(Button, { label: t('测试连接', 'Test connection'), busy: props.testing, onClick: props.onTest }),
        h(Button, { label: t('保存', 'Save'), kind: 'primary', busy: props.saving, onClick: props.onSave })),
      h('div', { className: 'acs-hint' }, t('测试使用已保存的配置，修改后请先保存。', 'The test uses the saved configuration; save edits first.')),
      result ? h('div', { className: 'acs-result ' + (result.ok ? 'acs-result-ok' : 'acs-result-bad') },
        h(Dot, { tone: result.ok ? 'ok' : 'error' }),
        h('span', null, result.text),
        result.detail ? h('span', { className: 'acs-dim acs-mono' }, result.detail) : null) : null);
    }

    function PlanBlock(props) {
      if (props.error) return h('div', { className: 'acs-errorbox' }, props.error);
      if (!props.plan) return null;
      const plan = obj(props.plan);
      const items = arr(plan.items);
      const conflicts = arr(plan.conflicts);
      const groups = [];
      for (const raw of items.slice(0, MAX_PLAN_ITEMS)) {
        const item = obj(raw);
        const category = txt(item.category) || 'other';
        let group = null;
        for (const current of groups) if (current.category === category) { group = current; break; }
        if (!group) { group = { category, items: [] }; groups.push(group); }
        group.items.push(item);
      }
      groups.sort((a, b) => catRank(a.category) - catRank(b.category) || a.category.localeCompare(b.category));
      return h('div', { className: 'acs-plan' },
        h('div', { className: 'acs-plan-meta' },
          h('span', null, t('生成于 ', 'Generated ') + fmtDateTime(plan.generatedAt)),
          h('span', { className: 'acs-dim' }, t(items.length + ' 项差异', items.length + ' differences')),
          conflicts.length ? h('span', { className: 'acs-inline-warn' }, t(conflicts.length + ' 项冲突', conflicts.length + ' conflicts')) : null),
        conflicts.length ? h(WarnBox, {
          title: t('冲突（同步时会保留本地副本）', 'Conflicts (a local copy is kept on sync)'),
          rows: conflicts.slice(0, MAX_REPORT_ROWS).map((raw, i) => {
            const item = obj(raw);
            return {
              key: 'plan-conflict' + i,
              main: txt(item.title) || txt(item.detail) || '—',
              extra: item.peer ? t('对端：', 'peer: ') + txt(item.peer) : '',
              message: txt(item.action),
            };
          }),
        }) : null,
        items.length === 0
          ? h('div', { className: 'acs-dim acs-empty' }, t('没有待同步的差异。', 'No pending differences.'))
          : groups.map((group) => h('div', { key: group.category, className: 'acs-plan-group' },
            h('div', { className: 'acs-subhead' }, categoryLabel(group.category), h('span', { className: 'acs-dim' }, ' ' + group.items.length)),
            group.items.map((item, i) => h('div', { key: 'plan-item' + i, className: 'acs-plan-item' },
              h('span', { className: 'acs-plan-title' }, txt(item.title) || txt(item.detail) || '—'),
              item.detail && item.title ? h('span', { className: 'acs-dim acs-plan-detail' }, oneLine(item.detail, 160)) : null,
              item.action ? h(Chip, { tone: actionTone(item.action) }, actionLabel(item.action)) : null,
              item.peer ? h('span', { className: 'acs-dim acs-plan-peer' }, txt(item.peer)) : null)))));
    }

    function ContentSection(props) {
      const form = props.form;
      const workspaces = arr(props.workspaces);
      const selectedPaths = form.workspacePaths === null ? workspaces.map((entry) => entry.path) : form.workspacePaths;
      return h(Section, {
        title: t('同步内容', 'Content'),
        hint: t('选择要在设备之间同步的数据。', 'Choose what is synced between devices.'),
        actions: h(Button, { label: t('扫描差异', 'Scan'), busy: props.scanning, onClick: props.onScan }),
      },
      h('div', { className: 'acs-toggles' }, CATEGORY_DEFS.map((def) => {
        return h(Toggle, {
          key: def.id,
          label: def.label,
          desc: def.desc,
          checked: form.categories[def.id] === true,
          disabled: props.saving,
          onChange: (checked) => props.onCategory(def.id, checked),
        });
      })),
      form.categories.workspaces === true ? h('div', { className: 'acs-subsection' },
        h('div', { className: 'acs-subhead' },
          t('工作区列表', 'Workspaces'),
          form.workspacePaths === null ? h('span', { className: 'acs-dim' }, ' ' + t('全部', 'all')) : null,
          form.workspacePaths !== null && workspaces.length
            ? h('button', { type: 'button', className: 'acs-linkbtn acs-subhead-action', onClick: () => props.onWorkspaces(null) }, t('全部同步', 'Sync all'))
            : null),
        workspaces.length === 0
          ? h('div', { className: 'acs-dim' }, t('未检测到工作区，默认同步全部。', 'No workspaces detected; all are synced by default.'))
          : h('div', { className: 'acs-wslist' }, workspaces.map((entry) => h('label', { key: entry.key, className: 'acs-ws-row' },
            h('input', {
              type: 'checkbox',
              checked: selectedPaths.indexOf(entry.path) >= 0,
              disabled: props.saving,
              onChange: (event) => props.onWorkspace(entry.path, event.target.checked, workspaces.map((ws) => ws.path)),
            }),
            h('span', { className: 'acs-mono acs-ws-path', title: entry.path }, entry.path)))),
        form.workspacePaths !== null ? h('div', { className: 'acs-hint' }, t('仅同步勾选的工作区。', 'Only the checked workspaces are synced.')) : null) : null,
      h(PlanBlock, { plan: props.plan, error: props.planError }));
    }

    function PeerCard(props) {
      const peer = obj(props.peer);
      const counts = obj(peer.categories);
      const name = txt(peer.name) || txt(peer.hostname) || txt(peer.deviceId) || t('未知设备', 'Unknown device');
      const meta = [txt(peer.hostname), txt(peer.platform), txt(peer.userId)].filter(Boolean).join(' · ');
      return h('div', { className: 'acs-peer' },
        h('div', { className: 'acs-peer-head' },
          h(Dot, { tone: peer.reachable === false ? 'warn' : 'ok' }),
          h('span', { className: 'acs-peer-name' }, name),
          peer.isSelf ? h(Chip, { tone: 'brand' }, t('本机', 'this device')) : null,
          peer.sameAccount === false ? h(Chip, { tone: 'warn' }, t('不同账户', 'different account')) : null),
        meta ? h('div', { className: 'acs-peer-meta' }, meta) : null,
        peer.sameAccount === false ? h('div', { className: 'acs-inline-warn' }, t('与它登录的账户不同，数据不会同步。', 'Signed into a different account; data is not synced with it.')) : null,
        h('div', { className: 'acs-peer-counts' }, CATEGORY_IDS.map((id) => h('span', { key: id },
          h('b', null, numText(counts[id])), ' ' + CATEGORY_LABEL[id]))),
        h('div', { className: 'acs-peer-time' }, t('更新于 ', 'Updated ') + fmtRel(peer.updatedAt)));
    }

    function PeersSection(props) {
      const list = props.peers === null || props.peers === undefined ? arr(obj(props.status).peers) : arr(props.peers);
      return h(Section, {
        title: t('设备', 'Devices'),
        hint: list.length ? t(list.length + ' 台设备', list.length + ' devices') : null,
        actions: h(Button, { label: t('刷新', 'Refresh'), kind: 'ghost', busy: props.busy, onClick: props.onRefresh }),
      },
      props.error ? h('div', { className: 'acs-errorbox' }, props.error) : null,
      list.length === 0
        ? h('div', { className: 'acs-dim acs-empty' }, t('尚未发现其他设备。', 'No other devices found yet.'))
        : h('div', { className: 'acs-peers' }, list.map((peer, i) => h(PeerCard, {
          key: txt(obj(peer).deviceId) || 'peer' + i,
          peer,
        }))));
    }

    function ReportBlock(props) {
      const r = obj(props.report);
      const applied = obj(r.applied);
      const pushed = obj(r.pushed);
      const pulled = obj(r.pulled);
      const installs = arr(applied.pluginInstalls).slice(0, MAX_REPORT_ROWS);
      const states = arr(applied.pluginStates).slice(0, MAX_REPORT_ROWS);
      const settings = arr(applied.settings).slice(0, MAX_REPORT_ROWS);
      const conflicts = arr(r.conflicts).slice(0, MAX_REPORT_ROWS);
      const errors = arr(r.errors).slice(0, MAX_REPORT_ROWS);
      const peers = arr(r.peers);
      const stats = [
        [t('发布插件', 'Plugins pushed'), flagText(pushed.plugins)],
        [t('发布设置', 'Settings pushed'), flagText(pushed.settings)],
        [t('发布工作区文件', 'Workspace files pushed'), numText(obj(pushed.workspaces).files)],
        [t('发布会话', 'Session files pushed'), numText(obj(pushed.sessions).files)],
        [t('发布技能', 'Skill files pushed'), numText(obj(pushed.skills).files)],
        [t('拉取工作区文件', 'Workspace files pulled'), numText(pulled.workspaceFiles)],
        [t('拉取会话', 'Session files pulled'), numText(pulled.sessionFiles)],
        [t('拉取技能', 'Skill files pulled'), numText(pulled.skillFiles)],
      ];
      const changed = installs.length + states.length + settings.length + conflicts.length + errors.length;
      return h('div', { className: 'acs-report' },
        h('div', { className: 'acs-report-meta' },
          h('span', null, fmtDateTime(r.startedAt) + ' → ' + fmtDateTime(r.finishedAt)),
          durationBetween(r.startedAt, r.finishedAt) ? h('span', { className: 'acs-dim' }, t('耗时 ', 'took ') + durationBetween(r.startedAt, r.finishedAt)) : null,
          r.transport ? h(Chip, null, TRANSPORT_LABEL[r.transport] || txt(r.transport)) : null,
          peers.length ? h('span', { className: 'acs-dim' }, t('对端：', 'Peers: ') + peers.map(txt).filter(Boolean).join(', ')) : null),
        h('div', { className: 'acs-stats' }, stats.map((pair, i) => h('div', { key: 'stat' + i, className: 'acs-stat' },
          h('span', { className: 'acs-stat-key' }, pair[0]),
          h('span', { className: 'acs-stat-val' }, pair[1])))),
        installs.length ? h(ListBlock, {
          title: t('插件安装', 'Plugin installs'),
          rows: installs.map((raw, i) => {
            const item = obj(raw);
            return {
              key: 'install' + i, tone: item.ok === true ? 'ok' : 'error',
              main: txt(item.name) || '—', extra: item.version ? 'v' + txt(item.version) : '',
              message: oneLine(item.message, 160),
            };
          }),
        }) : null,
        states.length ? h(ListBlock, {
          title: t('插件启用状态', 'Plugin enable state'),
          rows: states.map((raw, i) => {
            const item = obj(raw);
            return {
              key: 'state' + i, tone: item.ok === true ? 'ok' : 'error',
              main: txt(item.name) || '—',
              extra: item.enabled === true ? t('启用', 'enabled') : t('停用', 'disabled'),
              message: oneLine(item.message, 160),
            };
          }),
        }) : null,
        settings.length ? h(ListBlock, {
          title: t('已应用设置', 'Settings applied'),
          rows: settings.map((raw, i) => {
            const item = obj(raw);
            return { key: 'ns' + i, tone: item.ok === true ? 'ok' : 'error', main: txt(item.ns) || '—', message: oneLine(item.message, 160) };
          }),
        }) : null,
        conflicts.length ? h(WarnBox, {
          title: t('冲突（本地副本已保留）', 'Conflicts (local copies preserved)'),
          rows: conflicts.map((raw, i) => {
            const item = obj(raw);
            return {
              key: 'conflict' + i,
              main: (txt(item.category) ? txt(item.category) + ' · ' : '') + (txt(item.path) || '—'),
              extra: item.peer ? t('对端：', 'peer: ') + txt(item.peer) : '',
              message: item.savedAs ? t('副本：', 'copy: ') + txt(item.savedAs) : '',
            };
          }),
        }) : null,
        errors.length ? h(WarnBox, {
          title: t('错误', 'Errors'),
          rows: errors.map((raw, i) => {
            const item = obj(raw);
            return { key: 'error' + i, main: txt(item.category) || '—', message: oneLine(item.message, 240) };
          }),
        }) : null,
        changed === 0 ? h('div', { className: 'acs-dim acs-empty' }, t('本次没有应用任何变更。', 'No changes were applied.')) : null);
    }

    function ReportSection(props) {
      const report = props.report && typeof props.report === 'object' ? props.report : null;
      return h(Section, {
        title: t('最近报告', 'Last report'),
        hint: report ? fmtDateTime(report.finishedAt || report.startedAt) : null,
      }, report
        ? h(ReportBlock, { report })
        : h('div', { className: 'acs-dim acs-empty' }, t('还没有同步报告。', 'No sync report yet.')));
    }

    function LogSection(props) {
      const lines = arr(props.lines).slice(-LOG_LIMIT);
      return h(Section, {
        title: t('活动日志', 'Activity log'),
        hint: lines.length ? t('最近 ' + lines.length + ' 行', 'last ' + lines.length + ' lines') : null,
        actions: h(Button, { label: t('刷新', 'Refresh'), kind: 'ghost', busy: props.busy, onClick: props.onRefresh }),
      },
      props.error && lines.length === 0 ? h('div', { className: 'acs-errorbox' }, props.error) : null,
      lines.length === 0
        ? h('div', { className: 'acs-dim acs-empty' }, t('暂无日志。', 'No log entries yet.'))
        : h('div', { className: 'acs-log' }, lines.map((raw, i) => {
          const line = obj(raw);
          const level = LEVELS.indexOf(line.level) >= 0 ? line.level : 'info';
          return h('div', { key: 'log' + i, className: 'acs-log-row' },
            h('span', { className: 'acs-log-time' }, fmtClock(line.at)),
            h('span', { className: 'acs-log-level acs-lv-' + level }, LEVEL_LABEL[level]),
            h('span', { className: 'acs-log-text acs-lv-' + level }, txt(line.text)));
        })));
    }

    function FooterBar(props) {
      const form = props.form;
      const auto = form.autoSync;
      const interval = INTERVAL_VALUES.indexOf(Number(auto.intervalMs)) >= 0 ? Number(auto.intervalMs) : 300000;
      return h('div', { className: 'acs-footer' },
        h(Toggle, {
          label: t('自动同步', 'Auto sync'), checked: auto.enabled === true, disabled: !!props.busy,
          onChange: (enabled) => props.onAutoSync({ enabled, intervalMs: interval }),
        }),
        h('select', {
          className: 'acs-input acs-select-inline',
          value: String(interval),
          disabled: !!props.busy,
          onChange: (event) => props.onAutoSync({ enabled: auto.enabled === true, intervalMs: Number(event.target.value) }),
        }, INTERVAL_OPTIONS.map((option) => h('option', { key: option.value, value: String(option.value) }, option.label))),
        h(Toggle, {
          label: t('自动安装插件', 'Auto-install plugins'), checked: form.autoApplyPlugins === true,
          disabled: !!props.busy, onChange: (checked) => props.onAutoApply(checked),
        }),
        h('span', { className: 'acs-spacer' }),
        h(Button, { label: t('打开数据目录', 'Open data folder'), kind: 'ghost', busy: props.opening, onClick: props.onOpen }));
    }

    /* ------------------------------------------------------------------ panel */
    function Panel() {
      const [status, setStatus] = useState(null);
      const [loading, setLoading] = useState(true);
      const [loadError, setLoadError] = useState(null);
      const [form, setForm] = useState(null);
      const [dirty, setDirty] = useState(false);
      const [busy, setBusy] = useState({});
      const [notice, setNotice] = useState(null);
      const [testResult, setTestResult] = useState(null);
      const [peers, setPeers] = useState(null);
      const [peersError, setPeersError] = useState(null);
      const [plan, setPlan] = useState(null);
      const [planError, setPlanError] = useState(null);
      const [report, setReport] = useState(null);
      const [log, setLog] = useState([]);
      const [logError, setLogError] = useState(null);

      const mountedRef = useRef(true);
      const dirtyRef = useRef(false);
      const formRef = useRef(null);
      const readStatusRef = useRef(null);
      const noticeTimerRef = useRef(0);
      const configFpRef = useRef('');
      const patchCountRef = useRef(0);

      formRef.current = form;

      const showNotice = useCallback((ok, message) => {
        if (!mountedRef.current) return;
        setNotice({ ok: !!ok, text: String(message || '') });
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => { if (mountedRef.current) setNotice(null); }, NOTICE_MS);
      }, []);

      const runBusy = useCallback(async (key, work) => {
        if (!mountedRef.current) return undefined;
        setBusy((prev) => Object.assign({}, prev, { [key]: true }));
        try {
          return await work();
        } finally {
          if (mountedRef.current) {
            setBusy((prev) => {
              if (!prev[key]) return prev;
              const next = Object.assign({}, prev);
              delete next[key];
              return next;
            });
          }
        }
      }, []);

      const updateForm = useCallback((mutator) => {
        setForm((prev) => {
          if (!prev) return prev;
          const next = cloneForm(prev);
          return mutator(next) || next;
        });
      }, []);

      const mergeServerConfig = useCallback((config) => {
        if (!config || typeof config !== 'object') return;
        let fingerprint = '';
        try { fingerprint = JSON.stringify(config); } catch (err) { fingerprint = ''; }
        configFpRef.current = fingerprint;
        setForm((prev) => {
          if (!prev) return formFromConfig(config);
          const next = formFromConfig(config);
          if (dirtyRef.current) {
            next.transport = prev.transport;
            next.deviceName = prev.deviceName;
            next.folder = prev.folder;
            next.git = prev.git;
            next.webdav = prev.webdav;
            next.lan = prev.lan;
          }
          return next;
        });
      }, []);

      const patchConfig = useCallback(async (partial) => {
        patchCountRef.current += 1;
        setBusy((prev) => Object.assign({}, prev, { config: true }));
        try {
          const res = await requestJson('POST', '/config', partial);
          if (!mountedRef.current) return false;
          if (isBusyResponse(res)) { showNotice(false, busyMessage()); return false; }
          if (!res.ok || !res.data || res.data.ok === false) { showNotice(false, msgOf(res)); return false; }
          if (res.data.config) mergeServerConfig(res.data.config);
          showNotice(true, t('已保存。', 'Saved.'));
          return true;
        } catch (err) {
          if (mountedRef.current) showNotice(false, errText(err));
          return false;
        } finally {
          patchCountRef.current = Math.max(0, patchCountRef.current - 1);
          if (mountedRef.current) {
            setBusy((prev) => {
              if (!prev.config) return prev;
              const next = Object.assign({}, prev);
              delete next.config;
              return next;
            });
          }
        }
      }, [mergeServerConfig, showNotice]);

      const refreshStatus = useCallback(async () => {
        const read = readStatusRef.current;
        if (typeof read !== 'function') return;
        await runBusy('status', read);
      }, [runBusy]);

      const loadLog = useCallback(async () => {
        try {
          const res = await requestJson('POST', '/log', { limit: LOG_LIMIT });
          if (!mountedRef.current) return;
          if (isBusyResponse(res)) { setLogError(busyMessage()); return; }
          if (!res.ok || !res.data || res.data.ok === false) { setLogError(msgOf(res)); return; }
          setLog(arr(res.data.lines).slice(-LOG_LIMIT));
          setLogError(null);
        } catch (err) {
          if (mountedRef.current) setLogError(errText(err));
        }
      }, []);

      const refreshLog = useCallback(() => {
        void runBusy('log', loadLog);
      }, [loadLog, runBusy]);

      const setConnValue = useCallback((path, value) => {
        dirtyRef.current = true;
        setDirty(true);
        updateForm((next) => {
          let node = next;
          for (let i = 0; i < path.length - 1; i += 1) node = node[path[i]];
          node[path[path.length - 1]] = value;
          return next;
        });
      }, [updateForm]);

      const setCategory = useCallback((id, checked) => {
        const current = formRef.current;
        if (!current) return;
        const next = Object.assign({}, current.categories, { [id]: checked === true });
        updateForm((draft) => { draft.categories = next; return draft; });
        void patchConfig({ categories: next });
      }, [patchConfig, updateForm]);

      const setWorkspacePaths = useCallback((value) => {
        updateForm((draft) => { draft.workspacePaths = value; return draft; });
        void patchConfig({ workspacePaths: value });
      }, [patchConfig, updateForm]);

      const toggleWorkspace = useCallback((path, checked, allPaths) => {
        const current = formRef.current;
        if (!current) return;
        const selected = current.workspacePaths === null ? allPaths.slice() : current.workspacePaths.slice();
        let next;
        if (checked) next = selected.indexOf(path) < 0 ? selected.concat([path]) : selected;
        else next = selected.filter((entry) => entry !== path);
        const union = allPaths.slice();
        for (const entry of next) if (union.indexOf(entry) < 0) union.push(entry);
        const value = union.length > 0 && union.every((entry) => next.indexOf(entry) >= 0) ? null : next;
        setWorkspacePaths(value);
      }, [setWorkspacePaths]);

      const setAutoSync = useCallback((value) => {
        const next = {
          enabled: value && value.enabled === true,
          intervalMs: INTERVAL_VALUES.indexOf(Number(value && value.intervalMs)) >= 0 ? Number(value.intervalMs) : 300000,
        };
        updateForm((draft) => { draft.autoSync = next; return draft; });
        void patchConfig({ autoSync: next });
      }, [patchConfig, updateForm]);

      const setAutoApply = useCallback((checked) => {
        updateForm((draft) => { draft.autoApplyPlugins = checked === true; return draft; });
        void patchConfig({ autoApplyPlugins: checked === true });
      }, [patchConfig, updateForm]);

      const doSave = useCallback(async () => {
        const current = formRef.current;
        if (!current) return;
        await runBusy('save', async () => {
          try {
            const res = await requestJson('POST', '/config', payloadFromForm(current));
            if (!mountedRef.current) return;
            if (isBusyResponse(res)) { showNotice(false, busyMessage()); return; }
            if (!res.ok || !res.data || res.data.ok === false) { showNotice(false, msgOf(res)); return; }
            dirtyRef.current = false;
            setDirty(false);
            if (res.data.config) mergeServerConfig(res.data.config);
            showNotice(true, t('配置已保存。', 'Configuration saved.'));
            void refreshStatus();
          } catch (err) {
            if (mountedRef.current) showNotice(false, errText(err));
          }
        });
      }, [mergeServerConfig, refreshStatus, runBusy, showNotice]);

      const doTest = useCallback(async () => {
        setTestResult(null);
        await runBusy('test', async () => {
          try {
            const res = await requestJson('POST', '/test', {});
            if (!mountedRef.current) return;
            const data = obj(res.data);
            if (isBusyResponse(res)) { setTestResult({ ok: false, text: busyMessage() }); return; }
            if (!res.ok || res.data === null) { setTestResult({ ok: false, text: msgOf(res) }); return; }
            setTestResult({
              ok: data.ok === true,
              text: txt(data.message) || (data.ok === true ? t('连接成功。', 'Connected.') : t('连接失败。', 'Connection failed.')),
              detail: txt(data.detail) ? oneLine(data.detail, 200) : '',
            });
          } catch (err) {
            if (mountedRef.current) setTestResult({ ok: false, text: errText(err) });
          }
        });
      }, [runBusy]);

      const doSync = useCallback(async () => {
        await runBusy('sync', async () => {
          try {
            const res = await requestJson('POST', '/sync', {});
            if (!mountedRef.current) return;
            if (isBusyResponse(res)) { showNotice(false, busyMessage()); return; }
            if (!res.ok || !res.data || res.data.ok === false) { showNotice(false, msgOf(res)); return; }
            if (res.data.report) setReport(res.data.report);
            showNotice(true, t('同步完成。', 'Sync finished.'));
            void loadLog();
            void refreshStatus();
          } catch (err) {
            if (mountedRef.current) showNotice(false, errText(err));
          }
        });
      }, [loadLog, refreshStatus, runBusy, showNotice]);

      const doScan = useCallback(async () => {
        setPlanError(null);
        await runBusy('plan', async () => {
          try {
            const res = await requestJson('POST', '/plan', {});
            if (!mountedRef.current) return;
            if (isBusyResponse(res)) { setPlanError(busyMessage()); return; }
            if (!res.ok || !res.data || res.data.ok === false) { setPlanError(msgOf(res)); return; }
            setPlan(obj(res.data.plan));
          } catch (err) {
            if (mountedRef.current) setPlanError(errText(err));
          }
        });
      }, [runBusy]);

      const doPeers = useCallback(async () => {
        setPeersError(null);
        await runBusy('peers', async () => {
          try {
            const res = await requestJson('POST', '/peers', {});
            if (!mountedRef.current) return;
            if (isBusyResponse(res)) { setPeersError(busyMessage()); return; }
            if (!res.ok || !res.data || res.data.ok === false) { setPeersError(msgOf(res)); return; }
            setPeers(arr(res.data.peers));
          } catch (err) {
            if (mountedRef.current) setPeersError(errText(err));
          }
        });
      }, [runBusy]);

      const doOpen = useCallback(async () => {
        await runBusy('open', async () => {
          try {
            const res = await requestJson('POST', '/open', { target: 'data' });
            if (!mountedRef.current) return;
            if (!res.ok || !res.data || res.data.ok === false) { showNotice(false, msgOf(res)); return; }
            showNotice(true, txt(obj(res.data).message) || t('已打开数据目录。', 'Opened the data folder.'));
          } catch (err) {
            if (mountedRef.current) showNotice(false, errText(err));
          }
        });
      }, [runBusy, showNotice]);

      const doCopy = useCallback(async (value) => {
        const target = txt(value);
        if (!target) return;
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(target);
            showNotice(true, t('设备 ID 已复制。', 'Device ID copied.'));
            return;
          }
          throw new Error(t('剪贴板不可用', 'Clipboard unavailable'));
        } catch (err) {
          showNotice(false, t('复制失败：', 'Copy failed: ') + errText(err));
        }
      }, [showNotice]);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          clearTimeout(noticeTimerRef.current);
        };
      }, []);

      useEffect(() => {
        let alive = true;
        let reqId = 0;
        const read = async () => {
          const id = reqId + 1;
          reqId = id;
          try {
            const res = await requestJson('GET', '/status');
            if (!alive || id !== reqId) return;
            if (res.status === 409) { setLoadError(busyMessage()); return; }
            if (!res.ok || !res.data || typeof res.data !== 'object') { setLoadError(msgOf(res)); return; }
            setStatus(res.data);
            setLoadError(null);
          } catch (err) {
            if (!alive || id !== reqId) return;
            setLoadError(errText(err));
          } finally {
            if (alive) setLoading(false);
          }
        };
        readStatusRef.current = read;
        void read();
        const timer = setInterval(() => { if (alive) void read(); }, STATUS_POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
          readStatusRef.current = null;
        };
      }, []);

      useEffect(() => {
        const config = status && status.config;
        if (!config || typeof config !== 'object') return;
        if (dirtyRef.current || patchCountRef.current > 0) return;
        let fingerprint = '';
        try { fingerprint = JSON.stringify(config); } catch (err) { fingerprint = ''; }
        if (fingerprint === configFpRef.current) return;
        configFpRef.current = fingerprint;
        setForm(formFromConfig(config));
      }, [status]);

      useEffect(() => {
        void loadLog();
        return () => {};
      }, [loadLog]);

      let body;
      try {
        const config = status && status.config;
        const categories = obj(status && status.categories);
        const workspaceList = workspacesOf(status, config);
        const statusLog = status ? arr(status.log) : [];
        const logLines = log.length > 0 ? log : statusLog;
        const activeReport = report || (status && status.lastSync && typeof status.lastSync === 'object' && status.lastSync.report) || null;
        body = h('div', { className: 'acs-root' },
          notice ? h('div', {
            key: 'notice',
            className: 'acs-notice ' + (notice.ok ? 'acs-notice-ok' : 'acs-notice-err'),
            role: 'status',
          }, h(Dot, { tone: notice.ok ? 'ok' : 'error' }), h('span', null, notice.text)) : null,
          loadError ? h('div', { key: 'load-error', className: 'acs-errorbox' },
            h('span', null, t('读取状态失败：', 'Failed to read status: ') + loadError),
            h(Button, { label: t('重试', 'Retry'), kind: 'ghost', onClick: refreshStatus })) : null,
          status
            ? h(StatusSection, {
              key: 'status',
              status,
              syncing: !!busy.sync,
              refreshing: !!busy.status,
              onSync: doSync,
              onRefresh: refreshStatus,
              onCopy: doCopy,
            })
            : (loading ? h('div', { key: 'loading', className: 'acs-loading' }, h('span', { className: 'acs-spin' }), t('正在读取状态…', 'Reading status…')) : null),
          form
            ? h(ConnectionSection, {
              key: 'connection',
              form,
              dirty,
              saving: !!busy.save || !!busy.config,
              testing: !!busy.test,
              testResult,
              onChange: setConnValue,
              onSave: doSave,
              onTest: doTest,
            })
            : (status && config ? null : h('div', { key: 'waiting', className: 'acs-loading' }, h('span', { className: 'acs-spin' }), t('等待 Host 初始化…', 'Waiting for the Host to start…'))),
          form ? h(ContentSection, {
            key: 'content',
            form,
            status,
            workspaces: workspaceList,
            saving: !!busy.config,
            scanning: !!busy.plan,
            plan,
            planError,
            onCategory: setCategory,
            onWorkspace: toggleWorkspace,
            onWorkspaces: setWorkspacePaths,
            onScan: doScan,
          }) : null,
          h(PeersSection, {
            key: 'peers',
            status,
            peers,
            error: peersError,
            busy: !!busy.peers,
            onRefresh: doPeers,
          }),
          h(ReportSection, { key: 'report', report: activeReport }),
          h(LogSection, {
            key: 'log',
            lines: logLines,
            error: logError,
            busy: !!busy.log,
            onRefresh: refreshLog,
          }),
          form ? h(FooterBar, {
            key: 'footer',
            form,
            busy: !!busy.config,
            opening: !!busy.open,
            onAutoSync: setAutoSync,
            onAutoApply: setAutoApply,
            onOpen: doOpen,
          }) : null);
      } catch (err) {
        body = h('div', { className: 'acs-root' },
          h('div', { className: 'acs-errorbox' },
            t('面板渲染失败：', 'The panel failed to render: ') + errText(err)));
      }
      return body;
    }

    /* ------------------------------------------------------------------ styles */
    function ensureStyles() {
      if (ensureStyles.done || typeof document === 'undefined' || !document.head) return;
      ensureStyles.done = true;
      const css = `
.acs-root { display: flex; flex-direction: column; gap: 14px; padding: 2px 0 28px; min-width: 0; color: var(--dsw-alias-label-primary, #1a1c1f); font-size: 13px; line-height: 1.5; }
.acs-root *, .acs-root *::before, .acs-root *::after { box-sizing: border-box; }
.acs-root button { font: inherit; cursor: pointer; }
.acs-dim { color: var(--dsw-alias-label-tertiary, #8a8f98); font-weight: 400; }
.acs-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; overflow-wrap: anywhere; }
.acs-hint { color: var(--dsw-alias-label-tertiary, #8a8f98); font-size: 11px; }
.acs-empty { padding: 6px 0; }
.acs-loading { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary, #8a8f98); padding: 10px 0; }
.acs-spin { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; border: 2px solid var(--dsw-alias-label-tertiary, #8a8f98); border-top-color: var(--dsw-alias-label-primary, #1a1c1f); animation: acs-rotate .8s linear infinite; }
@keyframes acs-rotate { to { transform: rotate(360deg); } }
.acs-busy-line { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, #55595f); font-size: 11px; white-space: nowrap; }
.acs-notice { display: flex; align-items: center; gap: 8px; padding: 7px 11px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, #e8e9ec); background: var(--dsw-alias-bg-layer-2, #f6f7f8); overflow-wrap: anywhere; }
.acs-notice-ok { border-color: var(--dsw-alias-state-success-primary, #2f9e63); color: var(--dsw-alias-state-success-primary, #2f9e63); }
.acs-notice-err { border-color: var(--dsw-alias-state-error-primary, #d93f3f); color: var(--dsw-alias-state-error-primary, #d93f3f); }
.acs-errorbox { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 11px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary, #d93f3f); color: var(--dsw-alias-state-error-primary, #d93f3f); background: var(--dsw-alias-bg-layer-1, #ffffff); overflow-wrap: anywhere; }
.acs-inline-warn { color: var(--dsw-alias-state-warn-primary, #d98b1f); font-size: 11.5px; overflow-wrap: anywhere; }
.acs-section { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #e8e9ec); background: var(--dsw-alias-bg-layer-2, #f6f7f8); }
.acs-sec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.acs-sec-title { margin: 0; font-size: 13px; font-weight: 600; }
.acs-sec-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto; }
.acs-sec-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.acs-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 8px; white-space: nowrap; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2, #e2e4e8); background: var(--dsw-alias-bg-layer-3, #eceef1); color: var(--dsw-alias-label-primary, #1a1c1f); }
.acs-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #e4e7ea); }
.acs-btn:disabled { opacity: .55; cursor: default; }
.acs-btn-primary { border-color: var(--dsw-alias-brand-primary, #4f7cff); background: var(--dsw-alias-brand-primary, #4f7cff); color: #ffffff; }
.acs-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary, #4f7cff); opacity: .92; }
.acs-btn-ghost { background: transparent; }
.acs-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #e4e7ea); }
.acs-btnrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.acs-linkbtn { border: 0; background: none; padding: 0; color: var(--dsw-alias-brand-primary, #4f7cff); font-size: 11px; text-decoration: underline; cursor: pointer; }
.acs-chip { display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 999px; white-space: nowrap; border: 1px solid var(--dsw-alias-border-l2, #e2e4e8); background: var(--dsw-alias-bg-layer-3, #eceef1); color: var(--dsw-alias-label-secondary, #55595f); font-size: 11px; font-weight: 400; }
.acs-chip-ok { color: var(--dsw-alias-state-success-primary, #2f9e63); border-color: var(--dsw-alias-state-success-primary, #2f9e63); background: transparent; }
.acs-chip-warn { color: var(--dsw-alias-state-warn-primary, #d98b1f); border-color: var(--dsw-alias-state-warn-primary, #d98b1f); background: transparent; }
.acs-chip-error { color: var(--dsw-alias-state-error-primary, #d93f3f); border-color: var(--dsw-alias-state-error-primary, #d93f3f); background: transparent; }
.acs-chip-brand { color: var(--dsw-alias-brand-primary, #4f7cff); border-color: var(--dsw-alias-brand-primary, #4f7cff); background: transparent; }
.acs-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-label-tertiary, #8a8f98); }
.acs-dot-ok { background: var(--dsw-alias-state-success-primary, #2f9e63); }
.acs-dot-warn { background: var(--dsw-alias-state-warn-primary, #d98b1f); }
.acs-dot-error { background: var(--dsw-alias-state-error-primary, #d93f3f); }
.acs-dot-idle { background: var(--dsw-alias-label-tertiary, #8a8f98); }
.acs-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px 16px; min-width: 0; }
.acs-fact { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.acs-fact-key { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.acs-fact-val { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; overflow-wrap: anywhere; }
.acs-device-id { font-size: 11.5px; padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-bg-layer-3, #eceef1); }
.acs-transport-msg { font-size: 11px; overflow-wrap: anywhere; }
.acs-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px 12px; min-width: 0; }
.acs-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.acs-field-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #55595f); }
.acs-field-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #8a8f98); overflow-wrap: anywhere; }
.acs-input { width: 100%; min-width: 0; padding: 4px 8px; border-radius: 8px; font: inherit; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1, #e8e9ec); background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1a1c1f); }
.acs-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4f7cff); }
.acs-input:disabled { opacity: .6; }
.acs-select-inline { width: auto; }
.acs-toggle { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 4px 0; min-width: 0; }
.acs-toggle input { margin: 2px 0 0; flex: 0 0 auto; accent-color: var(--dsw-alias-brand-primary, #4f7cff); }
.acs-toggle-text { display: flex; flex-direction: column; gap: 0; min-width: 0; }
.acs-toggle-label { font-weight: 500; }
.acs-toggle-desc { display: block; color: var(--dsw-alias-label-tertiary, #8a8f98); font-size: 11px; overflow-wrap: anywhere; }
.acs-toggle-inline { padding: 2px 0 0; }
.acs-toggles { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 0 18px; }
.acs-subsection { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, #e8e9ec); background: var(--dsw-alias-bg-layer-1, #ffffff); min-width: 0; }
.acs-subhead { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #55595f); }
.acs-subhead-action { margin-left: auto; }
.acs-wslist { display: flex; flex-direction: column; gap: 1px; }
.acs-ws-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; cursor: pointer; min-width: 0; }
.acs-ws-row input { margin: 0; flex: 0 0 auto; accent-color: var(--dsw-alias-brand-primary, #4f7cff); }
.acs-ws-path { font-size: 11.5px; overflow-wrap: anywhere; }
.acs-result { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 7px 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, #e8e9ec); font-size: 12px; }
.acs-result-ok { border-color: var(--dsw-alias-state-success-primary, #2f9e63); color: var(--dsw-alias-state-success-primary, #2f9e63); }
.acs-result-bad { border-color: var(--dsw-alias-state-error-primary, #d93f3f); color: var(--dsw-alias-state-error-primary, #d93f3f); }
.acs-peers { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; min-width: 0; }
.acs-peer { display: flex; flex-direction: column; gap: 5px; min-width: 0; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, #e8e9ec); background: var(--dsw-alias-bg-layer-1, #ffffff); }
.acs-peer-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.acs-peer-name { font-weight: 600; overflow-wrap: anywhere; }
.acs-peer-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f98); overflow-wrap: anywhere; }
.acs-peer-counts { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary, #55595f); }
.acs-peer-counts b { color: var(--dsw-alias-label-primary, #1a1c1f); font-variant-numeric: tabular-nums; }
.acs-peer-time { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.acs-plan { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.acs-plan-meta { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 11.5px; }
.acs-plan-group { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.acs-plan-item { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 3px 0; font-size: 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e8e9ec); min-width: 0; }
.acs-plan-item:last-child { border-bottom: 0; }
.acs-plan-title { min-width: 0; overflow-wrap: anywhere; }
.acs-plan-detail { min-width: 0; overflow-wrap: anywhere; }
.acs-plan-peer { margin-left: auto; font-size: 11px; }
.acs-warnbox { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-warn-primary, #d98b1f); background: var(--dsw-alias-state-warn-tertiary, #fdf1de); color: var(--dsw-alias-state-warn-primary, #d98b1f); font-size: 12px; overflow-wrap: anywhere; }
.acs-warnbox-title { font-weight: 600; font-size: 11.5px; }
.acs-warnrow { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.acs-warnrow-main { overflow-wrap: anywhere; }
.acs-warnrow-msg { font-size: 11px; }
.acs-report { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
.acs-report-meta { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 11.5px; }
.acs-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 4px 14px; }
.acs-stat { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11.5px; }
.acs-stat-key { color: var(--dsw-alias-label-tertiary, #8a8f98); overflow-wrap: anywhere; }
.acs-stat-val { font-variant-numeric: tabular-nums; }
.acs-sublist { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.acs-subrow { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; min-width: 0; }
.acs-subrow-main { min-width: 0; overflow-wrap: anywhere; }
.acs-subrow-msg { min-width: 0; overflow-wrap: anywhere; font-size: 11px; }
.acs-log { display: flex; flex-direction: column; max-height: 300px; overflow: auto; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, #e8e9ec); background: var(--dsw-alias-bg-layer-1, #ffffff); }
.acs-log-row { display: grid; grid-template-columns: 62px 34px minmax(0, 1fr); gap: 8px; align-items: baseline; padding: 3px 10px; font-size: 11.5px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e8e9ec); }
.acs-log-row:last-child { border-bottom: 0; }
.acs-log-time { color: var(--dsw-alias-label-tertiary, #8a8f98); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; }
.acs-log-level { font-size: 10.5px; text-align: right; }
.acs-log-text { min-width: 0; overflow-wrap: anywhere; }
.acs-lv-info { color: var(--dsw-alias-label-secondary, #55595f); }
.acs-lv-warn { color: var(--dsw-alias-state-warn-primary, #d98b1f); }
.acs-lv-error { color: var(--dsw-alias-state-error-primary, #d93f3f); }
.acs-footer { display: flex; align-items: center; gap: 8px 14px; flex-wrap: wrap; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, #e8e9ec); background: var(--dsw-alias-bg-layer-2, #f6f7f8); }
.acs-footer .acs-toggle { padding: 0; }
.acs-spacer { flex: 1 1 auto; }
@media (max-width: 700px) {
.acs-section { padding: 10px 11px; }
.acs-sec-actions { margin-left: 0; flex-basis: 100%; }
.acs-facts { grid-template-columns: minmax(0, 1fr); }
.acs-fields { grid-template-columns: minmax(0, 1fr); }
.acs-toggles { grid-template-columns: minmax(0, 1fr); }
.acs-peers { grid-template-columns: minmax(0, 1fr); }
.acs-footer { align-items: flex-start; }
.acs-footer .acs-spacer { flex-basis: 100%; }
.acs-log-row { grid-template-columns: 56px 30px minmax(0, 1fr); }
}
@media (min-width: 701px) and (max-width: 820px) {
.acs-stats { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
}
`;
      const style = document.createElement('style');
      style.setAttribute('data-acs', 'account-sync');
      style.textContent = css;
      document.head.appendChild(style);
    }

    function tabLabel() {
      return t('账户同步', 'Account Sync');
    }

    ensureStyles();

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register(
            { name: 'settings.section', id: 'account-sync', order: 60, label: () => tabLabel() },
            Panel,
          ));
        } catch (error) {
          console.warn('[plugin-account-sync] slot "settings.section" mount failed', error);
        }
      },
    };
  },
});
