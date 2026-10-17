/**
 * WP387：信息监控配置卡（WP386 的 `pr.watch`）上的「让工坊替你建」。
 *
 * 不改 WP386 那个设置目标，只在外面包一层：
 * - 多一格开关「让工坊在你的浏览器里替你建」——开着保存，清单存好之后**马上出那张「要在你的 Google 账号里建
 *   N 条提醒」的卡**（建之前再问一次，T1）；你的浏览器还没接上时这一格默认关、问号里说为什么；
 * - 自动建不成（{@link markManualFallback}）时，这张配置卡重新弹出来，让人在没建成的那几行贴 RSS 链接
 *   （开关默认关，免得又去建一遍——不自动重试第二轮）。
 */
import type { PrWatchStore, SetupField } from '@agentsws/contracts'
import type { SetupTarget } from '../setup-cards.js'

export const BUILD_TOGGLE_KEY = 'build_by_browser'
const FALLBACK_KEY = 'alerts_manual_fallback'

/** 自动建不成：记一笔，配置卡下次问「设好了没有」时回「没有」（于是可以重新弹出来贴链接）。 */
export function markManualFallback(
  store: PrWatchStore,
  at: string,
  labels: readonly string[],
): void {
  store.setKv(FALLBACK_KEY, { at, labels: labels.slice(0, 20) })
}

/** 有没有在等人手动贴链接（自动建不成之后）。 */
export function manualFallbackPending(
  store: PrWatchStore,
): { at: string; labels: string[] } | undefined {
  // 清掉时存的是 null（库里那一格不许是空值）
  return store.kv<{ at: string; labels: string[] } | null>(FALLBACK_KEY) ?? undefined
}

export function withBrowserBuild(
  base: SetupTarget,
  deps: {
    store(): PrWatchStore
    /** 你的浏览器接上了没有。 */
    browserReady(): boolean
    /** 清单存好之后出那张卡（回出没出）。 */
    propose(): Promise<{ ok: boolean; reason?: string }>
  },
): SetupTarget {
  return {
    ...base,
    async fields(): Promise<SetupField[]> {
      const fields = await base.fields()
      const pending = manualFallbackPending(deps.store())
      const ready = deps.browserReady()
      const on = ready && pending === undefined
      return [
        ...fields,
        {
          key: BUILD_TOGGLE_KEY,
          label: '让工坊在你的浏览器里替你建',
          kind: 'toggle',
          suggested: on ? 'true' : 'false',
          suggested_why:
            pending !== undefined
              ? '上次没自动建成的几条，在上面那几行手动贴 RSS 链接就行'
              : ready
                ? '保存后先出一张卡列出要建的提醒，你确认一次才去建'
                : '你的浏览器还没接上（设置 → 浏览器），先手动建、把 RSS 链接贴回来',
          required: false,
        },
      ]
    },
    async satisfied(): Promise<boolean> {
      if (manualFallbackPending(deps.store()) !== undefined) return false
      return base.satisfied()
    },
    async apply(values): Promise<void> {
      const { [BUILD_TOGGLE_KEY]: build, ...rest } = values
      await base.apply(rest)
      deps.store().setKv(FALLBACK_KEY, null)
      if (build === 'true') await deps.propose()
    },
  }
}
