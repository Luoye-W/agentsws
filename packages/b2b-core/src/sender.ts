/**
 * WP173（docs/84 §2.3 / §11.1 第 4 条）：**发信邮箱**——单独域名的建议、SPF / DKIM / DMARC 体检。
 *
 * 新写的（BtoBAgents 里没有这部分）。纯函数：DNS 记录与测试信的信头由调用方查好了递进来
 * （服务进程用 `node:dns`，测试与模拟用替身），这里只判。
 *
 * 三条纪律：
 *
 * 1. **建议而不强制**：主域名也能发，只是卡上一句风险提示。**不问不设**——这里只列选项，
 *    选哪只是用户在卡上点的。
 * 2. **SPF 或 DKIM 没过不发**（送达前提，不是二选一）；DMARC 缺了只提示。
 * 3. **DKIM 要对齐**：测试信的 `dkim=pass` 签的得是**发信域名自己**（`header.d=`），
 *    签的是服务商的默认域名不算——那种信在对方那边照样对不上 DMARC。
 */
import type { B2bAuthResult, B2bSenderAuth } from '@agentsws/contracts'

/** 地址 → 域名（小写）。 */
export function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@')
  return at < 0
    ? ''
    : address
        .slice(at + 1)
        .replace(/>$/, '')
        .trim()
        .toLowerCase()
}

/** 两个域名是不是同一家（`mail.brand.com` 与 `brand.com` 算同一家）。 */
function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

/** 这只邮箱是不是单独的发信域名（与主站、客服邮箱都不同域）。 */
export function isSeparateSendingDomain(
  address: string,
  primary_domains: readonly string[],
): boolean {
  const d = domainOfAddress(address)
  if (d === '') return false
  return !primary_domains.some((p) => p.trim() !== '' && sameSite(d, p.trim().toLowerCase()))
}

/** 选择卡上的一个选项。`id` 形如 `separate:<地址>` / `separate_setup` / `primary:<地址>`。 */
export interface SenderChoiceOption {
  id: string
  label: string
  kind: 'separate' | 'separate_setup' | 'primary'
  address?: string
}

/** 卡上那两句（界面少字：长说明放教程）。 */
export const SENDER_CHOICE_SUMMARY =
  '强烈建议用单独的发信域名：开发信被标成垃圾邮件多了，整个域名的信誉会掉，客服回信和订单邮件也会跟着进垃圾箱。用哪只由你选；选哪只都要先过 SPF / DKIM 体检才发。'

/** 选了主域名时卡上 / 面板上那一句风险提示。 */
export const PRIMARY_DOMAIN_RISK = '用主域名发开发信：一旦被标成垃圾邮件，客服与订单邮件也会受连累'

/**
 * 「发信域名」那张卡的选项：①单独域名（已接的邮箱里不同域的那几只；一只都没有就给「看教程去买 /
 * 配」）②就用现在的邮箱（主域名那几只，带风险提示）。顺序固定：单独域名在前（推荐）。
 */
export function senderChoiceOptions(input: {
  /** 已接上的邮箱地址。 */
  mailboxes: readonly string[]
  primary_domains: readonly string[]
}): SenderChoiceOption[] {
  const separate = input.mailboxes.filter((m) => isSeparateSendingDomain(m, input.primary_domains))
  const primary = input.mailboxes.filter((m) => !separate.includes(m))
  const out: SenderChoiceOption[] = separate.map((address) => ({
    id: `separate:${address}`,
    label: `用单独的发信域名：${address}（推荐）`,
    kind: 'separate',
    address,
  }))
  if (separate.length === 0)
    out.push({
      id: 'separate_setup',
      label: '用单独的发信域名（还没有：看教程怎么买、怎么配）',
      kind: 'separate_setup',
    })
  for (const address of primary)
    out.push({
      id: `primary:${address}`,
      label: `就用现在的邮箱 ${address}（${PRIMARY_DOMAIN_RISK}）`,
      kind: 'primary',
      address,
    })
  return out
}

/** 卡上选中的那一项 → 选的是什么。认不出回 `undefined`。 */
export function parseSenderChoice(
  id: string,
): { kind: SenderChoiceOption['kind']; address?: string } | undefined {
  if (id === 'separate_setup') return { kind: 'separate_setup' }
  const m = /^(separate|primary):(.+@.+)$/.exec(id)
  if (m === null || m[1] === undefined || m[2] === undefined) return undefined
  return { kind: m[1] as 'separate' | 'primary', address: m[2] }
}

/** `Authentication-Results` 里的一条（`dkim=pass header.d=brand.com`）。 */
interface AuthClause {
  method: 'dkim' | 'spf' | 'dmarc'
  result: string
  domain?: string
}

/** 拆一行 `Authentication-Results`（多行 / 多个头用换行拼起来递进来也行）。 */
export function parseAuthResults(header: string): AuthClause[] {
  const out: AuthClause[] = []
  for (const raw of header.split(/[;\n]/)) {
    const m = /^\s*(dkim|spf|dmarc)\s*=\s*([a-z]+)(.*)$/i.exec(raw)
    if (m === null || m[1] === undefined || m[2] === undefined) continue
    const rest = m[3] ?? ''
    const d =
      /header\.d=([^\s;]+)/i.exec(rest)?.[1] ??
      /header\.i=@?([^\s;]+)/i.exec(rest)?.[1] ??
      /header\.from=([^\s;]+)/i.exec(rest)?.[1] ??
      /smtp\.mailfrom=(?:[^\s;@]+@)?([^\s;]+)/i.exec(rest)?.[1]
    out.push({
      method: m[1].toLowerCase() as AuthClause['method'],
      result: m[2].toLowerCase(),
      ...(d === undefined ? {} : { domain: domainOfAddress(`x@${d}`) }),
    })
  }
  return out
}

const TXT = (records: readonly string[] | undefined, prefix: string): string[] | undefined =>
  records
    ?.map((r) => r.replace(/^"|"$/g, '').trim())
    .filter((r) => r.toLowerCase().startsWith(prefix.toLowerCase()))

/**
 * 体检：SPF / DMARC 看 DNS（`undefined` = 没查成），DKIM 看测试信的信头。
 * 结果只是"过没过 + 为什么"，**发不发由 {@link senderAuthOk} 说**。
 */
export function evaluateSenderAuth(input: {
  domain: string
  /** `<domain>` 的 TXT 记录（没查成 = `undefined`）。 */
  spf_txt?: readonly string[] | undefined
  /** `_dmarc.<domain>` 的 TXT 记录。 */
  dmarc_txt?: readonly string[] | undefined
  /** 测试信收回来之后它的 `Authentication-Results`（还没收回来不给）。 */
  auth_header?: string | undefined
  /** 测试信发出去了没有（没发出去 DKIM 就是 unknown，不是 pending）。 */
  test_sent: boolean
}): Omit<B2bSenderAuth, 'checked_at' | 'test_message_id'> {
  const notes: string[] = []
  const domain = input.domain.toLowerCase()
  const clauses = input.auth_header === undefined ? [] : parseAuthResults(input.auth_header)

  let spf: B2bAuthResult
  const spfRecords = TXT(input.spf_txt, 'v=spf1')
  if (spfRecords === undefined) {
    spf = 'unknown'
    notes.push('SPF：DNS 没查成，稍后再查一次。')
  } else if (spfRecords.length === 0) {
    spf = 'missing'
    notes.push('SPF：DNS 里没有 SPF 记录（以 v=spf1 开头的 TXT）。照邮箱服务商给的写法加一条。')
  } else if (spfRecords.length > 1) {
    spf = 'fail'
    notes.push(`SPF：有 ${spfRecords.length} 条，只能有一条（多了等于没配），合成一条。`)
  } else if (/\+all\s*$/i.test(spfRecords[0] ?? '')) {
    spf = 'fail'
    notes.push('SPF：写成了 +all，等于谁都能冒充你发信。改成 ~all 或 -all。')
  } else spf = 'pass'
  const spfSeen = clauses.find((c) => c.method === 'spf')
  if (spf === 'pass' && spfSeen !== undefined && spfSeen.result !== 'pass') {
    spf = 'fail'
    notes.push(`SPF：测试信里是 ${spfSeen.result}——发信服务器不在你的 SPF 记录里。`)
  }

  let dmarc: B2bAuthResult
  const dmarcRecords = TXT(input.dmarc_txt, 'v=DMARC1')
  if (dmarcRecords === undefined) dmarc = 'unknown'
  else if (dmarcRecords.length === 0) {
    dmarc = 'missing'
    notes.push('DMARC：没有（_dmarc 那条 TXT）。不影响发，建议加一条 p=none 起步。')
  } else dmarc = 'pass'

  let dkim: B2bAuthResult
  const dkims = clauses.filter((c) => c.method === 'dkim')
  if (input.auth_header === undefined) {
    dkim = input.test_sent ? 'pending' : 'unknown'
    if (input.test_sent) notes.push('DKIM：测试信已发给你自己，收回来就知道过没过。')
  } else if (
    dkims.some((c) => c.result === 'pass' && c.domain !== undefined && sameSite(c.domain, domain))
  )
    dkim = 'pass'
  else {
    dkim = 'fail'
    const other = dkims.find((c) => c.result === 'pass' && c.domain !== undefined)
    notes.push(
      other !== undefined
        ? `DKIM：测试信签的是 ${other.domain}，不是 ${domain}。去邮箱服务商后台开「自定义域名 DKIM」。`
        : 'DKIM：测试信没带上你域名的 DKIM 签名。去邮箱服务商后台开 DKIM，把给的那条记录加进 DNS。',
    )
  }
  return {
    spf,
    dkim,
    dmarc,
    notes,
    // WP176：读了测试信的信头 = 实信验证
    ...(input.auth_header === undefined ? {} : { dkim_via: 'test_mail' as const }),
  }
}

/** WP176：测试信等多久没收回来，就改按 DNS 查 DKIM（10 分钟）。 */
export const DKIM_TEST_WAIT_MS = 10 * 60_000

/** WP176：该不该改按 DNS 查 DKIM 了（测试信在路上、发出去超过 10 分钟）。 */
export function dkimWaitedTooLong(
  auth: Pick<B2bSenderAuth, 'dkim' | 'test_sent_at' | 'checked_at'>,
  now: string,
): boolean {
  if (auth.dkim !== 'pending') return false
  const sent = Date.parse(auth.test_sent_at ?? auth.checked_at ?? '')
  return !Number.isNaN(sent) && Date.parse(now) - sent >= DKIM_TEST_WAIT_MS
}

/**
 * WP176：测试信收不回来时的**本机兜底**——按常见选择器（`B2B_DKIM_SELECTORS`）查
 * `<选择器>._domainkey.<域名>` 的 TXT。查到带公钥（`p=` 非空）的记录就算「DNS 已配置（未经实信验证）」：
 * 允许发，卡上写明；一个都查不到仍不发。`p=`（空）= 公钥被撤了，不算。
 *
 * `records` 按查询顺序给；`txt` 是 `undefined` = 那一个没查成（DNS 出错，不是"没有"）。
 */
export function evaluateDkimDns(input: {
  domain: string
  records: readonly { selector: string; txt: readonly string[] | undefined }[]
}): { dkim: B2bAuthResult; selector?: string; note: string } {
  for (const r of input.records) {
    const hit = (r.txt ?? [])
      .map((t) => t.replace(/"\s*"/g, '').replace(/^"|"$/g, '').trim())
      .find((t) => /(^|;)\s*p\s*=\s*[A-Za-z0-9+/=]{16,}/.test(t))
    if (hit !== undefined)
      return {
        dkim: 'pass',
        selector: r.selector,
        note: `DKIM：测试信 10 分钟没收回来（Gmail 自己发给自己的信常常不进收件箱），按 DNS 查到了「${r.selector}」的 DKIM 公钥——算 DNS 已配置（未经实信验证），可以发。`,
      }
  }
  if (input.records.length > 0 && input.records.every((r) => r.txt === undefined))
    return {
      dkim: 'unknown',
      note: 'DKIM：测试信没收回来，DNS 也没查成，稍后再查一次。',
    }
  return {
    dkim: 'missing',
    note: `DKIM：测试信没收回来，DNS 里常见的几个选择器也没查到 ${input.domain} 的 DKIM 记录。去邮箱服务商后台开 DKIM，把给的那条记录加进 DNS。`,
  }
}

/** 能不能发：SPF 与 DKIM 都要 pass（DMARC 不拦）。 */
export function senderAuthOk(auth: Pick<B2bSenderAuth, 'spf' | 'dkim'>): boolean {
  return auth.spf === 'pass' && auth.dkim === 'pass'
}
