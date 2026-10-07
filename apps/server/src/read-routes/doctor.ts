/**
 * WP246：取数路线的**体检**——每条路线每一级：通 / 不通 + 一句人话原因 + 怎么修。
 *
 * 两档：
 *
 * - 快查（打开连接页时）：不连网，只看配置与本机状态（关联了没有、找没找到浏览器、读号登没登、开关开没开），
 *   再带上每一级「最近一次真去取数」的结果；
 * - 重新体检（点按钮）：真去连一下——接口中台问一次价目（这项能力开没开）、读号读一页页头、
 *   YouTube / 第三方转文字各探一下通不通。
 *
 * 判据只有一份：岗位页「连上就能开工」（WP238 的 `readRouteLevelOf`）问的 Reddit 浏览器那一级通不通，
 * 也走 {@link redditBrowserCheck}。
 */
import type {
  DataSourceLevel,
  DataSourceRoute,
  ReadLevel,
  ReadLevelCheck,
  ReadonlyBrowserStatus,
  ReadRouteHealth,
  ReadRoutesDoctor,
} from '@agentsws/contracts'
import {
  DEFAULT_REDDIT_READ_ORDER,
  READ_ROUTE_SPECS,
  REDDIT_READ_ROUTE_LEVELS,
} from '@agentsws/contracts'
import type { RedditReadAccount } from '../readonly-browser/account.js'
import type { ReadRoutesStore } from './store.js'

export interface DoctorPorts {
  nowMs(): number
  store: ReadRoutesStore
  /** Reddit 那条的顺序与停用（WP220 的设置）。 */
  redditRoute(): DataSourceRoute
  /** 这台机器关联了 Agents 工坊账号没有。 */
  linked(): boolean
  /** 云上托管实例（没有浏览器）。 */
  hosted: boolean
  /** 重新体检时问一次接口中台这项能力的价（问不到 = 没开通）。 */
  workshopPrice?(capability: string): Promise<number | undefined>
  /** 本机只读浏览器（没装 = `undefined`）。 */
  browser?: { status(): ReadonlyBrowserStatus }
  account?: RedditReadAccount
  /** 重新体检时探一下某个站通不通（不给 = 不探，快查照旧）。 */
  probe?(url: string): Promise<{ ok: boolean; message: string }>
  youtubeBase?: string
  thirdPartyBase?: string
}

const off = (level: ReadLevel, reason: string, fix?: string): ReadLevelCheck => ({
  level,
  state: 'off',
  reason,
  ...(fix === undefined ? {} : { fix, action: 'enable_level' as const }),
})

/** Reddit 那条生效的顺序（只认两级、去重，缺的补在后面——与连接页那张表同一个算法）。 */
export function redditOrder(route: DataSourceRoute): ReadLevel[] {
  const levels = REDDIT_READ_ROUTE_LEVELS as readonly DataSourceLevel[]
  const saved = route.order.length === 0 ? [...DEFAULT_REDDIT_READ_ORDER] : route.order
  const order = saved.filter((l, i) => levels.includes(l) && saved.indexOf(l) === i)
  for (const l of levels) if (!order.includes(l)) order.push(l)
  return order as ReadLevel[]
}

/** Reddit 浏览器那一级（快查）：本机只读浏览器 + 读号。 */
export function redditBrowserCheck(
  ports: Pick<DoctorPorts, 'browser' | 'account' | 'hosted'>,
): ReadLevelCheck {
  const level: ReadLevel = 'browser_readonly'
  if (ports.hosted)
    return { level, state: 'off', reason: '云上托管实例没有浏览器，Reddit 只走接口中台。' }
  if (ports.browser === undefined)
    return { level, state: 'down', reason: '这个服务进程没装本机只读浏览器。' }
  const s = ports.browser.status()
  if (s.state === 'no_browser')
    return {
      level,
      state: 'down',
      reason: s.message ?? '这台电脑上没找到 Chrome / Edge。',
      fix: '装一个 Chrome 或 Edge（我们不替你下载）。',
      action: 'install_browser',
    }
  const acct = ports.account?.status()
  const who = acct?.username === undefined ? {} : { detail: `u/${acct.username}` }
  if (ports.account !== undefined) {
    const gate = ports.account.gate()
    if (!gate.ok) {
      if (acct?.state === 'logging_in')
        return { level, state: 'down', reason: gate.message, action: 'wait', ...who }
      // 原因只说「怎么了」，「怎么修」单独一格（提示里不重复）
      const reason =
        acct?.state === 'refused'
          ? `u/${acct.username ?? '?'} 是品牌登记的号（官方号 / 版主号），读取不用它。`
          : acct?.state === 'none' || acct === undefined
            ? '还没登录读号（Reddit 不登录基本都会被人机验证拦）。'
            : gate.message
      return {
        level,
        state: 'down',
        reason,
        fix:
          acct?.state === 'refused'
            ? '点「登录读号」，在窗口里退出这个号、换一个普通号。'
            : '点「登录读号」，用一个普通号在网页上登录（别用版主号 / 品牌官方号）。',
        action: 'login_read_account',
        ...who,
      }
    }
  }
  if (s.state === 'blocked')
    return {
      level,
      state: 'down',
      reason: `${s.message ?? '被站点拦了'}${s.until === undefined ? '' : `（暂停到 ${new Date(s.until).toLocaleTimeString()}）`}`,
      fix: '等暂停结束；是人机验证的话，点「登录读号」在窗口里手动过一次再关掉。',
      action: 'login_read_account',
      ...who,
    }
  if (s.state === 'quota_used_up')
    return {
      level,
      state: 'down',
      reason: s.message ?? '今天的页数用完了。',
      fix: '明天再读，或在设置里调高上限。',
      action: 'wait',
      ...who,
    }
  return {
    level,
    state: 'ok',
    reason:
      acct === undefined
        ? `本机 ${s.browser ?? 'Chrome'} 只读打开 Reddit 页面，不扣积分。`
        : `用读号只读打开 Reddit 页面（不扣积分；最近 24 小时 ${s.pages_last_day} / ${s.max_pages_per_day} 页）。`,
    ...who,
  }
}

async function redditWorkshop(ports: DoctorPorts, deep: boolean): Promise<ReadLevelCheck> {
  const level: ReadLevel = 'workshop'
  if (!ports.linked())
    return {
      level,
      state: 'down',
      reason: '没关联 Agents 工坊账号。',
      fix: '到「设置 › 云端账号」关联（这一级按条扣积分）。',
      action: 'link_account',
    }
  if (deep && ports.workshopPrice !== undefined) {
    const price = await ports.workshopPrice('social.reddit.search').catch(() => undefined)
    if (price === undefined)
      return {
        level,
        state: 'down',
        reason: '接口中台这一项现在没开（或云连不上）。',
        fix: '过一会儿再体检。',
        action: 'wait',
      }
    return {
      level,
      state: 'ok',
      reason: `接口中台取数，按条扣积分（约 ${Math.round(price * 1000) / 1000} 积分一条）。`,
    }
  }
  return { level, state: 'ok', reason: '已关联 Agents 工坊账号：接口中台取数，按条扣积分。' }
}

async function reddit(ports: DoctorPorts, deep: boolean): Promise<ReadLevelCheck[]> {
  const route = ports.redditRoute()
  if (deep && ports.account !== undefined && ports.browser !== undefined && !ports.hosted) {
    const st = ports.account.status().state
    if (st !== 'logging_in' && ports.browser.status().state !== 'no_browser')
      await ports.account.check().catch(() => undefined)
  }
  const out: ReadLevelCheck[] = []
  for (const level of redditOrder(route)) {
    if (route.disabled.includes(level as DataSourceLevel)) {
      out.push(off(level, '这一级被你关了。', '在 Reddit 卡的「数据从哪里来」里打开。'))
      continue
    }
    out.push(level === 'workshop' ? await redditWorkshop(ports, deep) : redditBrowserCheck(ports))
  }
  return out
}

async function probed(
  ports: DoctorPorts,
  deep: boolean,
  url: string,
  ok: ReadLevelCheck,
  what: string,
): Promise<ReadLevelCheck> {
  if (!deep || ports.probe === undefined) return ok
  const got = await ports.probe(url)
  return got.ok
    ? ok
    : {
        level: ok.level,
        state: 'down',
        reason: `这台电脑连不上${what}（${got.message}）。`,
        fix: '检查网络或代理。',
        action: 'check_network',
      }
}

async function youtube(ports: DoctorPorts, deep: boolean): Promise<ReadLevelCheck[]> {
  const base = ports.youtubeBase ?? 'https://www.youtube.com'
  return [
    await probed(
      ports,
      deep,
      `${base}/robots.txt`,
      {
        level: 'page_captions',
        state: 'ok',
        reason: '零配置：直接读视频页里的字幕轨，不经第三方。',
      },
      ' YouTube',
    ),
    { level: 'workshop', state: 'pending', reason: '接口中台的 YouTube 字幕还没接。' },
  ]
}

async function web(ports: DoctorPorts, deep: boolean): Promise<ReadLevelCheck[]> {
  const local: ReadLevelCheck = {
    level: 'local_extract',
    state: 'ok',
    reason: '零配置：本机取网页、本机抽正文，不经第三方。',
  }
  if (!ports.store.settings().web_third_party_reader)
    return [
      local,
      off(
        'third_party_reader',
        '默认关：开了之后，本机抽不出时网址会发给第三方（Jina Reader）。',
        '要的话在这里打开。',
      ),
    ]
  const base = ports.thirdPartyBase ?? 'https://r.jina.ai'
  return [
    local,
    await probed(
      ports,
      deep,
      `${base}/`,
      {
        level: 'third_party_reader',
        state: 'ok',
        reason: '已开：本机抽不出时转给 Jina Reader（网址会发给对方）。',
      },
      ' Jina Reader',
    ),
  ]
}

/** 跑一遍体检（`deep` = 重新体检，真去连网）。 */
export async function runReadRoutesDoctor(
  ports: DoctorPorts,
  deep: boolean,
): Promise<ReadRoutesDoctor> {
  const routes: ReadRouteHealth[] = []
  for (const spec of READ_ROUTE_SPECS) {
    const levels =
      spec.platform === 'reddit'
        ? await reddit(ports, deep)
        : spec.platform === 'youtube'
          ? await youtube(ports, deep)
          : await web(ports, deep)
    const withLast = levels.map((c) => {
      const last = ports.store.last(spec.platform, c.level)
      return last === undefined ? c : { ...c, last }
    })
    const active = withLast.find((c) => c.state === 'ok')?.level
    routes.push({
      platform: spec.platform,
      route_key: spec.route_key,
      tool: spec.tool,
      levels: withLast,
      ...(active === undefined ? {} : { active }),
    })
  }
  return { routes, checked_at: new Date(ports.nowMs()).toISOString(), deep }
}
