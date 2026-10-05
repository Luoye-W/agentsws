# WP227 10-05 决定的几处跟进（官网与条款、消息页、官方场景、清旧代码）

worktree `../agentsws-wt/wp227-followups` · 分支 `wp/227-followups`（从 main 新起）。先读 `_common.md`、`docs/briefs/DECISIONS.md` 末尾「10-05 Luoye 答复」、`docs/87`（官网）、`docs/88`（消息中心）、`apps/site/src/content/legal/*.md` 与 `apps/site/src/lib/legal.ts`、WP197 / WP202 / WP204 / WP218 报告。

## 要做
1. **不支持退款**（Luoye：「我们不支持退款的啊」）：`refund.md`（中英）改成「积分一经购买不退款、不折现」；只留三种例外：重复扣款、系统错误多扣（查实后退回或补积分）、你所在地法律强制要求的情形。拒付：冲回这笔付款还没用掉的积分，可暂停账号的付费功能（开源软件照用）。`terms.md`、定价页、FAQ 里提到退款的地方同步；赔偿上限（责任上限）保留不动。欧盟消费者的 14 天撤销权：数字内容在付款后立即交付、用户在付款前明确同意放弃撤销权的可以不退——条款里写清，并在报告里列出**私有仓结账页要加的那个勾选框**（交 Fable，不在本单做）。页首注释里「WP190 口径」那段改成新口径出处。
2. **官网**：首屏维持现用标题；「台阶」那里提到 KOLAgents、KefuAgents 的地方加去它们官网的链接（新窗口、`rel="noopener"`）；首页 Windows 下载按钮旁加一行小字「第一次打开若被拦，点『更多信息 → 仍要运行』」（WP218 决定 ⑤，中英）。
3. **邮件正文里的链接**：点了用系统浏览器打开（桌面壳走 `shell.openExternal`，网页版走新窗口 `noopener,noreferrer`）；只放行 http / https / mailto，其它协议一律不开。iframe 沙箱照 WP204 现状，只为这一步开最小的口子；写测试。
4. **营销信打标签**：消息页里营销邮件折叠（不动用户邮箱）并打上「营销」标签（状态图标风格、少字，docs/36 §7），用户一眼认得出；判定沿用现有分类，没有就照 docs/88 的口径加最小规则，写测试。
5. **官方场景默认工作文件夹**：从 `~/dsh-workspace` 改到「文稿/Agents 工坊」（mac `~/Documents/Agents 工坊`，Windows `%USERPROFILE%\Documents\Agents 工坊`，中文与空格路径要过 Windows 测试路径）；老用户已有的 `~/dsh-workspace` 不搬、继续用（只改新装默认），写进设置说明。
6. **删开源仓里那份旧的红人公共库代码**（WP202 §3 第 2 条）：线上跑的是私有仓那份。删之前列清单（文件、被谁引用），确认无运行时引用再删；契约里给私有仓用的那部分不动。

## 纪律
不跑批量清理命令（删旧代码用 `git rm` 点名文件）；不读 .env*；本机 4317 服务别碰。并行中：WP223（设计 / 视频）、WP224（投放 / 公司事实 / 秘书）、WP226（persona）、WP219 / WP220 / WP222 待合并——碰到同一文件只做你这几处，冲突留给 Fable。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `open-repo-boundary` + 官网构建；截图：退款页、首页下载按钮、消息页营销标签、链接点击；报告 `docs/briefs/reports/WP227.md`（要 Luoye 定的事单列）。
