/**
 * `shopify theme …` 那条子进程路径的替身（WP44 交付 4 的模拟侧）。
 *
 * **为什么它不是一条 Action。** 主题工作走的是 Shopify 官方 CLI，用的是 CLI 自己那套
 * 登录 / Theme Access 密码，**不经连接器**——`apps/server/src/shopify-theme.ts` 里
 * 那几条 `execFile` 就是真身。所以模拟里也不该让它冒充一次连接器调用：
 * 那会在出站观察表（16 §3）里凭空多出一条根本不存在的记录，
 * 还会让 `no_write_without_stage` 去检查一件它管不着的事。
 *
 * 它管得着的是**发布**那一下——`publish_theme` 是账本上的一条变更，永远要人点头
 * （15 §2 hard_ceiling）。所以这个替身的纪律是：
 *
 * - `pushUnpublished` 随便调，造出来的永远是 `unpublished`，线上一个字节不动；
 * - `publish` **只该由执行器在变更批准之后调**——跟真身上那句注释是同一条。
 *
 * 状态直接落在 `MockState.themes` 上：店铺就一份状态，CLI 改的和 Admin API 读的
 * 必须是同一份，不然"发布完再去列一遍"会看到两个不同的世界。
 */

import type { Iso8601 } from '@agentsws/contracts'
import type { MockState, MockTheme } from './state.js'

/** `theme list --json` 里我们要的那几个字段（与 `apps/server/src/shopify-theme.ts` 同形）。 */
export interface StandInThemeSummary {
  id: string
  name: string
  role: string
  updated_at?: Iso8601
  preview_url?: string
}

export interface StandInPushedTheme {
  theme_id: string
  theme_name: string
  preview_url?: string
  /** 本地工作副本在哪。替身不落盘，给一条形状对得上的路径。 */
  path: string
}

export interface MockShopifyCliOptions {
  state: MockState
  now(): Iso8601
  /** 演示店域名；只用来拼预览链接。 */
  shop?: string
  /** 每条命令都记一笔：命令名 + 主题 id。**不记令牌、不记输出。** */
  onCommand?(cmd: string, detail: Record<string, unknown>): void
}

/**
 * 主题 CLI 替身。方法名与 `ShopifyTheme` 一一对得上，
 * 换成真身时场景里那几行不用改。
 */
export class MockShopifyCli {
  private readonly state: MockState
  private readonly nowOf: () => Iso8601
  private readonly shop: string
  private readonly onCommand: (cmd: string, detail: Record<string, unknown>) => void
  private seq = 0

  constructor(opts: MockShopifyCliOptions) {
    this.state = opts.state
    this.nowOf = opts.now
    this.shop = opts.shop ?? 'demo.myshopify.com'
    this.onCommand = opts.onCommand ?? ((): void => {})
  }

  /** `shopify theme list --json`。 */
  list(): StandInThemeSummary[] {
    this.onCommand('theme list', {})
    return this.state.themes.map((t) => ({ ...t }))
  }

  /** 线上那一份；一家店同一时刻只可能有一个。 */
  live(): StandInThemeSummary | undefined {
    return this.state.themes.find((t) => t.role === 'main')
  }

  /**
   * `shopify theme push --unpublished --json`。
   *
   * 造出来的永远是副本。预览链接就是审批材料——人点开看一眼再决定要不要发布。
   */
  pushUnpublished(input: { name: string }): StandInPushedTheme {
    this.seq += 1
    const id = `thm_${this.seq}`
    const theme: MockTheme = {
      id,
      name: input.name,
      role: 'unpublished',
      updated_at: this.nowOf(),
      preview_url: `https://${this.shop}?preview_theme_id=${id}`,
    }
    this.state.themes.push(theme)
    this.onCommand('theme push --unpublished', { theme_id: id })
    return {
      theme_id: id,
      theme_name: theme.name,
      ...(theme.preview_url === undefined ? {} : { preview_url: theme.preview_url }),
      path: `/tmp/agentsws/themes/${this.shop}`,
    }
  }

  /**
   * `shopify theme publish --theme <id>`。
   *
   * **只有审批过的 `publish_theme` 变更才该调它**——这是替身，不是门禁，
   * 门禁在账本那一侧；这里只负责把线上那一份换掉。
   */
  publish(input: { theme_id: string }): {
    theme_id: string
    previous_theme_id: string | undefined
  } {
    const target = this.state.themes.find((t) => t.id === input.theme_id)
    if (target === undefined) throw new Error(`主题不存在：${input.theme_id}`)
    if (target.role === 'main') throw new Error(`${target.name} 已经是线上主题了`)
    const previous = this.state.themes.find((t) => t.role === 'main')
    if (previous !== undefined) previous.role = 'unpublished'
    target.role = 'main'
    target.updated_at = this.nowOf()
    this.onCommand('theme publish', { theme_id: target.id })
    return { theme_id: target.id, previous_theme_id: previous?.id }
  }
}
