# 发布 Account Sync / Publishing Account Sync

本文件记录把这个插件发布到 npm、GitHub 与官方插件市场（awesome-dsh-plugin）的步骤。
当前维护者：`karla-zhang`。

## 1. npm 发布（安装入口）

官方市场的条目用 npm 作为安装来源，所以先发 npm：

```powershell
cd D:\BaiduSyncdisk\deepseek-harness\plugin-account-sync
& "C:\Program Files\nodejs\npm.cmd" whoami --cache D:\BaiduSyncdisk\deepseek-harness\.npm-cache
& "C:\Program Files\nodejs\npm.cmd" pack --dry-run --cache D:\BaiduSyncdisk\deepseek-harness\.npm-cache
& "C:\Program Files\nodejs\npm.cmd" publish --cache D:\BaiduSyncdisk\deepseek-harness\.npm-cache
```

更新时先改 `package.json` 的 `version` 再发一次。发布后用户可在
**插件 → 已安装 → 添加插件** 里按包名 `dsh-plugin-account-sync` 安装。

## 2. GitHub 仓库

```powershell
# 仓库需为 public，并添加 topic：dsh-plugin
git remote add origin https://github.com/karla-zhang/dsh-plugin-account-sync.git
git push -u origin main
```

本仓库自带 `package.json` 的 `dsh.bundle`、`dsh.client`、`cordis.patch.yml`、`icon.svg`
与 `LICENSE`，克隆后即可 `install_bundle` 指向仓库目录。

## 3. 官方插件市场（awesome-dsh-plugin）

规则（2026-11 实测）：

- 条目文件：`data/plugins/<owner>__<repo>.yml`，只读 `data/plugins/*.yml` 这一层。
- 仓库必须存在 **至少 1 天**（`MIN_AGE_DAYS = 1`），且声明 `dsh.bundle`；没有 commit 数门槛。
- README / README.zh.md 由 CI 生成，不要手改。
- 提 PR 后由 `PR check` + `Submission gate` 检查；仓库刚建时 gate 会因为“仓库太新”失败，等满 24 小时后自动重跑即可通过（无需关闭重开 PR）。

提交步骤：

1. fork `awesome-dsh-plugin/awesome-dsh-plugin`（本账号已 fork）。
2. 从上游 `main` 拉分支，添加 `data/plugins/karla-zhang__dsh-plugin-account-sync.yml`（内容见本目录 `awesome-dsh-plugin.yml`）。
3. 向上游 `main` 发 PR，标题 `Add dsh-plugin-account-sync (karla-zhang)`。

## 4. 自建索引（可选）

`market/index.json` 是 format-1 市场索引，可通过 jsDelivr / 任意静态托管提供给
**插件 → 发现 → Index sources**（只做发现，不提供一键安装）。
