/**
 * 云侧那两页网页（WP110）。
 *
 * WP58 的后置清单第 ② 条："云侧没有网页版登录页"——于是 magic link 的默认落点
 * `${baseUrl}/cloud/auth/callback` 是一条**不存在的路由**：不带 `callback_url`
 * 调一次 magic-link，信发出去了，点开是 404。这个文件补的就是那一页。
 *
 * 三条约束：
 *
 * 1. **纯服务端渲染的静态 HTML，没有前端构建**。这两页一共显示不到二十个字，
 *    为它们拉一套打包器意味着云镜像里多一层构建产物与一份要跟着升级的依赖。
 * 2. **页面上不出现任何凭据**：`/login` 验完一次性 token 之后**不把会话 token
 *    印在页面上**。本地关联那条路走的是回环回调（token 直接进本机服务进程），
 *    网页这一页只负责回答"你这个邮箱能收到信、链接有效"。
 * 3. **一个字都不编**：健康与版本从装配方传进来，问不到就不显示那一格。
 */

import { BRAND_DISC, BRAND_GREEN, brandMark } from './brand.js'

const escapeHtml = (raw: string): string =>
  raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 两页共用的壳。深浅两套色跟系统走（没有切换器——这两页没有"设置"）。 */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --paper: #F3F5F2; --card: #FFFFFF; --ink: #1B1D22; --muted: #5B6169; --line: #ECEFEA; --brand: ${BRAND_GREEN}; }
@media (prefers-color-scheme: dark) { :root { --paper: #0E100F; --card: #171A19; --ink: #EDEFEC; --muted: #9AA1A7; --line: #242826; --brand: #76FB91; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; background: var(--paper); color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Roboto, sans-serif; line-height: 1.7; }
main { width: 100%; max-width: 520px; background: var(--card); border-radius: 16px; padding: 32px 28px; box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06); }
.mark { width: 56px; height: 56px; border-radius: 28px; background: ${BRAND_DISC}; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 20px; }
h1 { font-size: 22px; margin: 0 0 10px; letter-spacing: .2px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: 14px; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 20px 0 0; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
dt { font-weight: 600; }
dd { margin: 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
a { color: var(--brand); }
.ok { color: var(--brand); font-weight: 600; }
</style>
</head>
<body><main>
<div class="mark">${brandMark({ size: 38, id: 'awpage' })}</div>
${body}
</main></body>
</html>
`
}

export interface IndexPageInfo {
  version: string
  /** 云自己的对外地址（信里那条链接就指着它）。 */
  baseUrl: string
  /** 这个节点挂了哪些模块（与 `/v1/cloud/health` 同一份）。 */
  modules: Record<string, boolean>
}

const MODULE_LABELS: Record<string, string> = {
  entry: '模型与钱包（/v1/ai、/v1/wallet）',
  standby: '在线值守（/v1/standby）',
  kol_public: '公共红人库（/v1/data/kol）',
  mail: '登录邮件投递',
  admin_topup: '管理员手动充值',
}

/** `GET /`：一页说明 + 状态。没有登录表单——登录从本地工作台发起。 */
export function indexPage(info: IndexPageInfo): string {
  const rows = Object.entries(info.modules)
    .map(
      ([key, on]) =>
        `<dt>${escapeHtml(MODULE_LABELS[key] ?? key)}</dt><dd>${on ? '<span class="ok">已挂上</span>' : '没挂'}</dd>`,
    )
    .join('\n')
  return shell(
    'agentsws 云',
    `<h1>agentsws 云</h1>
<p>这台机器提供 agentsws 的云上能力：用积分跑模型、公共红人库、在线值守。</p>
<p class="muted">这里没有网页控制台。要用它，请在自己电脑上的 agentsws 里打开
<strong>设置 → 账号与积分</strong>，关联一次账号——登录信、令牌、余额都在那边。</p>
<dl>
<dt>版本</dt><dd><code>${escapeHtml(info.version)}</code></dd>
<dt>地址</dt><dd><code>${escapeHtml(info.baseUrl)}</code></dd>
${rows}
</dl>`,
  )
}

export type LoginOutcome =
  | { kind: 'ok'; email_domain: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }

/**
 * `GET /login`：magic link 的落地页。
 *
 * 三种结局各一句人话。**过期 / 用过 / 根本不存在合成一句**——分开说等于告诉
 * 试探的人"这一条确实签发过"（与 `POST /v1/cloud/auth/verify` 同一条纪律）。
 */
export function loginPage(outcome: LoginOutcome): string {
  if (outcome.kind === 'ok')
    return shell(
      '已登录 · agentsws 云',
      `<h1>已登录</h1>
<p><span class="ok">${escapeHtml(outcome.email_domain)}</span> 这个邮箱收得到我们的信，链接也有效。</p>
<p>回到你电脑上的 agentsws 继续——这一页可以关掉了。</p>
<p class="muted">如果你是在「设置 → 账号与积分」里点的关联，本地那一步会自己完成，
不需要从这一页复制任何东西。</p>`,
    )
  if (outcome.kind === 'missing')
    return shell(
      '登录 · agentsws 云',
      `<h1>这条链接不完整</h1>
<p>地址里没有登录凭据——多半是邮件客户端把链接截断了。</p>
<p class="muted">把信里那条链接整条复制到浏览器地址栏，或者回到 agentsws 里重新发一封。</p>`,
    )
  return shell(
    '登录 · agentsws 云',
    `<h1>这条链接用不了了</h1>
<p>登录链接只能用一次，而且 15 分钟就过期。</p>
<p class="muted">回到你电脑上的 agentsws，点一次「发登录邮件」，会有一封新的。</p>`,
  )
}
