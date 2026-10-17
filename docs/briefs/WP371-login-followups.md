# WP371 本机登录后续：托盘直接进、工坊账号认人、记住我 30 天（决策 942–944，Luoye 10-17 按建议）

worktree `../agentsws-wt/wp371-login` · 分支 `wp/371-login`（从 main 拉；main 须已含 WP358 与决策 945 的 NAS 登录，没有就从 `int/1017` 拉、收尾前合最新 main）。先读 `_common.md`、`docs/briefs/reports/WP358.md`（第四、五节方案 A / B / C）、`docs/briefs/reports/D945.md`、`docs/13` §5、`packages/api/src/routes/identity.ts`、`apps/server/src/server.ts`、`apps/server/src/setup-code.ts`、桌面壳托盘与 `main.ts`、工作台登录页。

## 要做
1. **942 托盘「在浏览器打开」直接进**：只在个人模式、只对本机地址（服务只听 127.0.0.1 / ::1）。壳向本机服务要一条一次性登录链接（15 分钟、用一次就废），交给系统浏览器打开；落地后立刻用掉并把 token 从地址栏抹掉（`history.replaceState`）。局域网档（D945）一律不发。这是 13 §5「token 不进 URL」的例外，代码里注明决策 942。
2. **943 工坊账号认人（方案 B）**：本机成员可以用工坊账号（邮箱 + 验证码，走现有云端账号登录，WP231 那套）证明身份进工作区；主人邮箱在首次设置就用已登录的工坊账号邮箱。一次性链接留作备用。局域网档里同事仍只走邀请，主人可用设置码或工坊账号。
3. **944 浏览器「记住我」30 天（方案 C）**：浏览器会话从 12 小时拉到 30 天；桌面壳照旧自己续。退出、改成员、撤邀请时会话立即失效。
4. 文案中英两份、界面少字；`docs/help` 登录相关段落同步。

## 测试
服务端：一次性链接只本机档发、用一次即废、过期拒；局域网档不发；工坊账号认人成功 / 邮箱不是成员拒；30 天会话与撤销。端到端（真服务进程 + stub 云）：托盘链接进门、工坊账号进门。桌面壳单测。截图（浅 / 深）。`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口、不连真实云端；不连远程机器；不碰本机 4317；不批量清理；不用 pkill；截图用别的端口、拍完停掉，不写 .review-ready。不合 main、不打 tag、不发版（决策 381）。报告 `docs/briefs/reports/WP371.md`（决策号 986–990 起；若 981–985 被整理分支用了也不冲突），白话写。
