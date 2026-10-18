/**
 * WP387（docs/103 v2 §3.3、T1）：**受保护页面上的写操作，要先有卡**。
 *
 * 个人档里浏览器的写操作（点击、输入、选择）本来是放行的——那是用户自己的浏览器、自己的登录态
 * （WP82 / WP92）。但有几页上的一次点击改的是用户**外部账号里的东西**：`google.com/alerts` 上点
 * 「创建提醒」就是在他的 Google 账号里多了一条提醒。这几页列在契约的 `BROWSER_WRITE_GUARDS` 里，
 * 规矩是：**只有那张卡同意之后的那一次运行**（服务端给 `RunRequest.browser_grants` 写上同一种
 * `change_kind` 的凭据）才放行；别的运行——包括用户在对话里随口说「去帮我改一下提醒」——一律拦下，
 * 拦下的理由说人话（`browser_write_needs_card: …`）。
 *
 * 门禁不知道浏览器现在停在哪一页，只看得见**模型让它打开过哪个地址**。所以这里记一个「当前页」：
 *
 * | 调用 | 当前页 |
 * |---|---|
 * | 打开一个地址（`bsk_page{navigate}` / `bsk_session{start,url}` / `bsk_tabs{create,url}`；官方那一种的 `browser_navigate` / `browser_tabs{new,url}`） | 就是那个地址 |
 * | 换标签、借标签、回退 / 前进（`bsk_tabs{select,borrow}`、`bsk_page{back,forward}`、`browser_tabs{select}`、`browser_navigate_back`） | **认不出** |
 * | 别的（点击、输入、截图……） | 不变 |
 *
 * 「认不出」时怎么判：这次运行**到过**受保护的页面，就当它还在那里（最严）；没到过就当不在。
 * 打开一个地址本身不算改东西（它只是去看），所以 navigate 不拦，拦的是之后那一下点击 / 输入。
 *
 * 管不到的一种情况（写清楚，免得以为管住了）：模型在别的页面上点一个链接、被带进了受保护页面，
 * 门禁看不见那次跳转。技能说明里写死「直接打开 google.com/alerts」，所以正常路径不会这样走；
 * 真这样走了，结果也只是这次运行的写操作没被这一道拦——账本、卡、读回链接那几道照旧。
 */
import type { BrowserWriteGuard, RunBrowserGrant } from '@agentsws/contracts'
import { browserWriteGuardOf } from '@agentsws/contracts'
import { browserSkillNavigationUrl, browserSkillToolName } from './browserskill.js'
import { browserToolName } from './tools.js'

/** 这次调用要打开的地址（不打开任何地址回 `undefined`；两种浏览器都认）。 */
function navigationTarget(tool: string, args: Record<string, unknown>): string | undefined {
  const bsk = browserSkillToolName(tool)
  if (bsk !== undefined) return browserSkillNavigationUrl(bsk, args)
  const short = browserToolName(tool)
  if (short === 'browser_navigate') return typeof args.url === 'string' ? args.url : undefined
  if (short === 'browser_tabs' && args.action === 'new')
    return typeof args.url === 'string' ? args.url : undefined
  return undefined
}

/** 这次调用之后浏览器停在哪一页就认不出了。 */
function losesTrack(tool: string, args: Record<string, unknown>): boolean {
  const action = typeof args.action === 'string' ? args.action : undefined
  const bsk = browserSkillToolName(tool)
  if (bsk === 'bsk_tabs') return action === 'select' || action === 'borrow'
  if (bsk === 'bsk_page') return action === 'back' || action === 'forward'
  // 不带地址开一个 Agent 窗口：停在空白页，不算认不出
  const short = browserToolName(tool)
  if (short === 'browser_navigate_back') return true
  if (short === 'browser_tabs') return action === 'select'
  return false
}

export interface BrowserWriteGuardState {
  /** 当前页（认不出 = `undefined` 且 `unknown: true`）。 */
  current?: string
  unknown: boolean
  /** 这次运行到过的受保护页面（认不出时按它判）。 */
  touched?: BrowserWriteGuard
}

export interface BrowserWriteGuardApi {
  /**
   * 每次浏览器工具调用**放行之前**问一句：`effect` 是读写分类那一关判出来的。
   * 回 `undefined` = 这一道没话说；回字符串 = 拒（人话原因）。
   * 放行了的调用会顺手更新「当前页」。
   */
  check(input: {
    tool: string
    args: Record<string, unknown>
    effect: 'read_external' | 'write_external' | 'local' | string
  }): string | undefined
  /** 测试 / 面板用：现在认的是哪一页。 */
  state(): Readonly<BrowserWriteGuardState>
}

/** 一次运行一个（状态跟着这次运行走）。 */
export function createBrowserWriteGuard(
  grants: readonly RunBrowserGrant[] | undefined,
): BrowserWriteGuardApi {
  const granted = new Set((grants ?? []).map((g) => g.change_kind))
  const s: BrowserWriteGuardState = { unknown: false }

  const guardNow = (): BrowserWriteGuard | undefined => {
    if (s.unknown) return s.touched
    return s.current === undefined ? undefined : browserWriteGuardOf(s.current)
  }

  return {
    check({ tool, args, effect }) {
      const target = navigationTarget(tool, args)
      if (target !== undefined) {
        // 打开一个地址：只是去看，不拦；记下来，之后的点击按它判
        s.current = target
        s.unknown = false
        const g = browserWriteGuardOf(target)
        if (g !== undefined) s.touched = g
        return undefined
      }
      if (losesTrack(tool, args)) {
        // 换 / 借标签、回退：不改账号里的东西，但之后停在哪一页认不出了
        delete s.current
        s.unknown = true
        return undefined
      }
      if (effect === 'write_external') {
        const g = guardNow()
        if (g !== undefined && !granted.has(g.change_kind))
          return `browser_write_needs_card: ${g.reason}（这次没有同意过的卡，没点）`
      }
      return undefined
    },
    state: () => ({ ...s }),
  }
}
