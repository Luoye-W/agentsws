# WP292 发版不再要 R2 令牌：CI 只打包，Fable 本机用 wrangler 传 R2（Luoye 10-10）

worktree `../agentsws-wt/wp292-relup` · 分支 `wp/292-relup`（从 main 新起）。先读 `docs/briefs/reports/WP218.md`（§4 首次发版清单）、`.github/workflows/release.yml`、`scripts/release-manifest.mjs`、`_common.md`。

## 背景
`dl.agentsws.com` 已由 Fable 10-10 绑到 R2 桶 `agentsws-downloads`（自定义域，min TLS 1.2）。原设计要 Luoye 建 R2 读写令牌并把 `R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ACCOUNT_ID` 填进 GitHub secrets；Luoye 希望这步由 Fable 做，而密钥不经 AI。改法：**CI 不碰 R2**，Fable 在本机用已登录的 wrangler OAuth 上传。

## 要做
1. `release.yml`：没有 R2 三个 secret 时**不再报错**，跳过 R2 上传两步（安装包 / yml / downloads.json），照常建 GitHub Release、上传 artifact（含 `latest*.yml`、`downloads.json`、安装包、blockmap），并在 summary 写一句「R2 交给本机 `scripts/release-upload-r2.mjs`」。有 secret 时行为不变。
2. 新脚本 `scripts/release-upload-r2.mjs --run <run_id> | --dir <本地目录> [--channel beta|stable] [--dry-run]`：用 `gh run download` 取那次 release 的 artifact（或读本地目录），按 release.yml 原来的 R2 目录结构与顺序上传（先安装包 / blockmap，后 `latest*.yml`，最后根目录 `downloads.json`），`*.yml` / `downloads.json` 带 `Cache-Control: no-cache`、安装包带一年 immutable；上传用 `wrangler r2 object put agentsws-downloads/<key> --file … --cache-control … --content-type … --remote`，跑 wrangler 时一律 `CI=true WRANGLER_SEND_METRICS=false env -u CLOUDFLARE_API_TOKEN`。默认 dry-run 只打印计划；`--run` 才传。上传后 `curl` 校验 `https://dl.agentsws.com/<channel>/latest.yml` 能取到且版本对。
3. 脚本自测（假 wrangler / 假 gh）：目录结构、顺序、cache-control、content-type、dry-run 不调用 wrangler。
4. 更新 WP218 报告的「首次发版清单」与 docs/35 顶部「装包流程」：R2 令牌那两行改成「不需要」。

## 纪律
不读 .env*；不碰任何 key / token；不跑批量清理；本机 4317 别碰；不连远程机器；**不真的上传、不推 tag、不建 release**（只做代码与假替身测试）。

## 验证
`scripts/verify-changed.sh`（含 scripts 测试）、`actionlint`（若本机有）或 yaml 解析检查；报告 `docs/briefs/reports/WP292.md`。
