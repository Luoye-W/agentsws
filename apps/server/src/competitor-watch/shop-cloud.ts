/**
 * WP402（决策 1140 / 1146）：独立站的**云端代读**（取数链第 2 条路）——本机直接读和内置浏览器都被挡时，
 * 让工坊云端去读同一个公开数据地址（`shop.page`，同步、按次扣积分；只认 Shopify / WooCommerce 那几个公开数据地址）。
 * 云端照实自报身份去读、原文交回，本机用同一份解析（`readShopCatalog`）。
 *
 * 不是那几种地址的一律不发（本机先拦一道，云端再拦一道）。扣了多少积分照云端回的实数记，对话 / 连接卡说一句。
 * 用户看得到的字只说「工坊云端」。
 */
import type { BrowserTextRead } from '@agentsws/brand-intake'
import { type DataCallResult, isShopPageUrl, SHOP_PAGE_CLOUD_CAPABILITY } from '@agentsws/contracts'

/** 数据能力口里用得到的那一样（`createDataService(cloud)` 交回的那一份）。 */
export interface ShopPageCloudPort {
  call(
    capability: string,
    input: { input: Record<string, unknown>; fresh?: boolean },
  ): Promise<DataCallResult>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** 云端代读的那一口（形状和内置浏览器一样）；每次扣的积分交给 `onCredits`。 */
export function shopPageCloudRead(
  port: ShopPageCloudPort,
  onCredits?: (credits: number) => void,
): BrowserTextRead {
  return async (url) => {
    if (!isShopPageUrl(url)) return { ok: false, message: '工坊云端只代读公开商品数据的那几个地址' }
    try {
      const r = await port.call(SHOP_PAGE_CLOUD_CAPABILITY, { input: { url } })
      if (r.credits > 0) onCredits?.(r.credits)
      const item = r.items[0]
      const text = str(item?.text)
      if (item === undefined || text === undefined)
        return { ok: false, message: '工坊云端这次没交回内容' }
      const status = typeof item.status === 'number' ? item.status : 200
      return {
        ok: true,
        status,
        final_url: str(item.final_url) ?? url,
        text,
        ...(item.truncated === true ? { truncated: true } : {}),
        ...(item.challenge === true ? { challenge: true } : {}),
      }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }
}
