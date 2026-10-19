/**
 * WP424（Luoye 10-19）：「邮件营销」不等于 Klaviyo——这类**好几家都能干**的连接器，只有用户说过
 * 自己在用哪一家（品牌档案的 `email_service`，第 ② 步档案卡 / 设置页填，或建档时从官网认出来）才把那一家当成「要连的」；
 * 没说过（或说的那家目录里还没有）就只是「可选」。值是这条 kind 去档案里读哪一格。
 *
 * WP431：首次设置（`onboarding.ts`）与岗位页那条「还没连上：…」（`connection-directory.ts`）共用这一份判据。
 */
export const VENDOR_CHOICE_KINDS: Readonly<Record<string, 'email_service'>> = {
  email_marketing: 'email_service',
}

/** 名字归一：小写、去掉空白与标点、去掉「（邮件营销）」这类括号说明。 */
function vendorKey(value: string): string {
  return value
    .replace(/[（(].*$/u, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '')
}

/**
 * WP424：用户说的那一家（「Klaviyo」「shopify email」）对上连接目录里的哪一个 provider。
 * 按 provider id 与卡上名字认，大小写、空格、括号说明都不算；对不上回 `undefined`。
 */
export function matchVendorService(
  stated: string | undefined,
  candidates: readonly { service: string; label: string }[],
): string | undefined {
  if (stated === undefined) return undefined
  const key = vendorKey(stated)
  if (key.length < 3) return undefined
  return candidates.find((c) => {
    const keys = [vendorKey(c.service), vendorKey(c.label)].filter((k) => k.length >= 3)
    return keys.some((k) => k === key || key.includes(k) || k.includes(key))
  })?.service
}
