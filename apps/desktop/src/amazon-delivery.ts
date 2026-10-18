/**
 * WP394（docs/104 §2.3 / §6 第 2 条）：把内置浏览器里 Amazon 某站的「配送到」设成目标市场的一个邮编。
 *
 * 为什么要设：Amazon 的价格跟着「配送到哪」走。这台电脑出口在境外时，Amazon 会认成别的国家（实测认成加拿大），
 * 价格变成加元、还写「这件不能配送到你选的地址」——读回来的数就不能拿来和昨天比。
 *
 * 怎么设：和人在页头点「Deliver to」、填邮编、点「Apply」走的是**同一个**地址接口（Amazon 自己的页面脚本也是这么调的）：
 * 先取一次改地址要的口令，再交邮编。**不登录**，设的只是 Amazon 记在这个品牌 partition 里的地址 cookie。
 * 请求同样带 `Agent/AgentsWorkshop`（会话的 webRequest 统一加）。不点页面、不填表、不过验证码。
 *
 * 这个函数会被 `toString()` 成字符串送进页面执行，**里面不能引用模块里的任何东西**。
 * 接口形状来自 Amazon 页面公开的脚本，没有官方文档；审核方验收时实测「设了能不能保持住」（派工单第 3 条）。
 */

export interface DeliveryScriptResult {
  ok: boolean
  /** 交邮编那一步的 HTTP 状态（取口令就失败了是 0）。 */
  status: number
  message?: string
}

export async function setAmazonDeliveryZip(args: { zip: string }): Promise<DeliveryScriptResult> {
  try {
    const sel = await fetch(
      '/portal-migration/hz/glow/get-rendered-address-selections?deviceType=desktop&pageType=Gateway&storeContext=NoStoreName&actionSource=desktop-modal',
      { credentials: 'include' },
    )
    const html = await sel.text()
    const token = /CSRF_TOKEN\s*:\s*["']([^"']+)["']/.exec(html)?.[1]
    if (token === undefined) return { ok: false, status: 0, message: '没拿到改地址要的口令' }
    const res = await fetch('/portal-migration/hz/glow/address-change?actionSource=glow', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'anti-csrftoken-a2z': token },
      body: JSON.stringify({
        locationType: 'LOCATION_INPUT',
        zipCode: args.zip,
        deviceType: 'web',
        storeContext: 'generic',
        pageType: 'Gateway',
        actionSource: 'glow',
      }),
    })
    let valid = res.ok
    try {
      const j = (await res.json()) as { isValidAddress?: number | boolean }
      if (j.isValidAddress !== undefined) valid = valid && Boolean(j.isValidAddress)
    } catch {
      // 回的不是 JSON：只看状态码
    }
    return valid
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, message: 'Amazon 没认这个邮编' }
  } catch (err) {
    return { ok: false, status: 0, message: String(err) }
  }
}
