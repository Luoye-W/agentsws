/**
 * 主流邮箱预设 + 按域名自动识别（WP25 交付 B）。
 *
 * 为什么要有这一份：让一个开淘宝店出身的老板去翻"IMAP 服务器地址是多少"，
 * 十有八九填错端口然后放弃。域名的 MX 记录本来就写着这封信归谁收——
 * 问一句邮箱地址、查一次 MX，主机端口就全有了，用户只剩下一个真的只有他知道的东西：
 * 授权码。
 *
 * 三条纪律：
 * 1. **预设表全仓只有这一份**：服务端从这里生成 `/v1/connections/providers` 与
 *    `/v1/connections/mail/detect` 的回包，前端不许再抄一份。
 * 2. **识别永不抛**：DNS 不通、域名没有 MX、地址写错，一律回 `preset: null`，
 *    表单回退到手填。识别失败比阻塞开局便宜得多。
 * 3. 纯匹配（{@link matchPresetByMx}）与查网（{@link detectMailbox}）分开，
 *    前者可以不联网测试。
 *
 * 一条要写在最前面的现实：**微软的个人 Outlook.com 与 Microsoft 365 的 IMAP/SMTP
 * 基础认证已经被微软关掉了**（2024 年起要 OAuth2 / XOAUTH2）。所以它的预设标
 * `oauth_required`，界面上直说"下一版走 Microsoft 授权登录"，不让用户白填一遍密码。
 */

export type MailboxPresetId =
  | 'aliyun_qiye'
  | 'tencent_exmail'
  | 'netease_qiye'
  | 'zoho'
  | 'google'
  | 'microsoft'
  | 'qq'
  | 'netease_163'
  | 'icloud'
  | 'yahoo'

/**
 * 这家邮箱要用什么当密码。
 *
 * - `app_password`：要去后台开一个"授权码 / 应用专用密码"，登录密码填进去必然失败；
 * - `password`：企业邮多数就用登录密码（管理员没另开限制的话）；
 * - `oauth_required`：这家已经关掉了用户名口令登录，v1 连不了。
 */
export type MailboxAuthKind = 'app_password' | 'password' | 'oauth_required'

export interface MailboxPreset {
  id: MailboxPresetId
  /** 中文名，直接显示给用户看（"识别到 QQ 企业邮"）。 */
  label: string
  imap_host: string
  imap_port: number
  /** 993 / 465 是隐式 TLS；587 是 STARTTLS（先明文连上再升级）。 */
  imap_encryption: 'tls' | 'starttls'
  smtp_host: string
  smtp_port: number
  smtp_encryption: 'tls' | 'starttls'
  auth: MailboxAuthKind
  /**
   * MX 目标主机的后缀。等值或以 `.后缀` 结尾都算命中。
   *
   * 有几条**不是**这家的品牌域名——阿里企业邮的 MX 落在 `mxhichina.com`，
   * Microsoft 365 落在 `mail.protection.outlook.com`——正因为猜不出来才要写下来。
   */
  mx_suffixes: string[]
  /** 一句话：授权码在哪儿开，或者为什么现在连不了。 */
  note: string
  /** 官方说明的外链（用户照着点就能开）。 */
  help_url?: string
}

/**
 * 预设表。顺序有意义：**先企业邮后个人邮**——真拿它当客服邮箱用的是企业邮，
 * 而 `qq.com` / `163.com` 这类后缀既可能是个人邮也可能是企业邮的兜底 MX，
 * 所以更精确的企业邮后缀必须排在前面（{@link matchPresetByMx} 按表序取第一个命中）。
 */
export const MAILBOX_PRESETS: readonly MailboxPreset[] = [
  {
    id: 'aliyun_qiye',
    label: '阿里企业邮箱',
    imap_host: 'imap.qiye.aliyun.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtp.qiye.aliyun.com',
    smtp_port: 465,
    smtp_encryption: 'tls',
    auth: 'password',
    mx_suffixes: ['mxhichina.com', 'qiye.aliyun.com', 'alibaba-inc.com'],
    note: '一般用邮箱登录密码就行。管理员如果开了"安全登录"，要在网页版设置里生成一个客户端专用密码。',
    help_url: 'https://help.aliyun.com/zh/mail/',
  },
  {
    id: 'tencent_exmail',
    label: '腾讯企业邮箱',
    imap_host: 'imap.exmail.qq.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtp.exmail.qq.com',
    smtp_port: 465,
    smtp_encryption: 'tls',
    auth: 'app_password',
    // `mxbiz1/2.qq.com` 是关键：企业自有域名接腾讯企业邮之后，MX 就指到这两台。
    // 少了它们，`mxbiz1.qq.com` 会顺着 `.qq.com` 掉进下面那条 **QQ 个人邮**，
    // 于是给企业用户填 imap.qq.com——主机错了，怎么试都连不上。
    mx_suffixes: ['exmail.qq.com', 'qqmail.com', 'mxbiz1.qq.com', 'mxbiz2.qq.com'],
    note: '要用"客户端专用密码"，不是网页登录密码：网页版 → 设置 → 微信通知与安全 → 客户端专用密码。',
    help_url: 'https://open.work.weixin.qq.com/help2/pc/19886',
  },
  {
    id: 'netease_qiye',
    label: '网易企业邮箱',
    imap_host: 'imap.qiye.163.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtp.qiye.163.com',
    smtp_port: 465,
    smtp_encryption: 'tls',
    auth: 'app_password',
    mx_suffixes: ['qiye163.com', 'qiye.163.com', 'qiye.aliyun.com.cn'],
    note: '先在网页版设置里打开 IMAP/SMTP，然后生成一个客户端授权码填进来。',
    help_url: 'https://qiye.163.com/help/',
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    imap_host: 'imappro.zoho.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtppro.zoho.com',
    smtp_port: 465,
    smtp_encryption: 'tls',
    auth: 'app_password',
    mx_suffixes: ['zoho.com', 'zoho.eu', 'zohomail.com', 'zohomail.eu'],
    note: '开了两步验证就要用 Application-Specific Password（在 Zoho 账号安全页生成）。',
    help_url: 'https://www.zoho.com/mail/help/imap-access.html',
  },
  {
    id: 'google',
    label: 'Gmail / Google Workspace',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_encryption: 'tls',
    auth: 'app_password',
    mx_suffixes: ['google.com', 'googlemail.com', 'aspmx.l.google.com'],
    note: '必须开两步验证，然后生成"应用专用密码"（16 位、带空格的那一串，空格可去掉）。',
    help_url: 'https://support.google.com/accounts/answer/185833',
  },
  {
    id: 'microsoft',
    label: 'Microsoft 365 / Outlook.com',
    imap_host: 'outlook.office365.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtp.office365.com',
    smtp_port: 587,
    smtp_encryption: 'starttls',
    auth: 'oauth_required',
    mx_suffixes: [
      'mail.protection.outlook.com',
      'outlook.com',
      'hotmail.com',
      'olc.protection.outlook.com',
    ],
    note: '微软已经关掉了"用户名 + 密码"收发信，必须走 Microsoft 授权登录——这一版还没做，下一版补上。现在填密码是连不上的。',
    help_url:
      'https://learn.microsoft.com/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online',
  },
  {
    id: 'qq',
    label: 'QQ 邮箱',
    imap_host: 'imap.qq.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtp.qq.com',
    smtp_port: 465,
    smtp_encryption: 'tls',
    auth: 'app_password',
    mx_suffixes: ['qq.com'],
    note: '要用 16 位"授权码"，不是 QQ 密码：网页版 → 设置 → 账号 → 开启 IMAP/SMTP 服务，然后生成授权码。',
    help_url: 'https://service.mail.qq.com/detail/0/75',
  },
  {
    id: 'netease_163',
    label: '163 / 126 邮箱',
    imap_host: 'imap.163.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtp.163.com',
    smtp_port: 465,
    smtp_encryption: 'tls',
    auth: 'app_password',
    // `mxmail.netease.com` 是关键：163 / 126 个人邮箱的 MX 就落在那儿
    // （`163mx00.mxmail.netease.com`），少了它按 MX 一条都认不出来
    mx_suffixes: ['163.com', '126.com', 'yeah.net', '163mx.com', 'mxmail.netease.com'],
    note: '要用"客户端授权码"，不是登录密码：网页版 → 设置 → POP3/SMTP/IMAP → 开启并新增授权密码。',
    help_url: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b',
  },
  {
    id: 'icloud',
    label: 'iCloud 邮箱',
    imap_host: 'imap.mail.me.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtp.mail.me.com',
    smtp_port: 587,
    smtp_encryption: 'starttls',
    auth: 'app_password',
    mx_suffixes: ['icloud.com', 'me.com', 'mail.icloud.com'],
    note: '要在 Apple ID 页面生成"App 专用密码"；发信端口是 587（STARTTLS），不是 465。',
    help_url: 'https://support.apple.com/102654',
  },
  {
    id: 'yahoo',
    label: 'Yahoo 邮箱',
    imap_host: 'imap.mail.yahoo.com',
    imap_port: 993,
    imap_encryption: 'tls',
    smtp_host: 'smtp.mail.yahoo.com',
    smtp_port: 465,
    smtp_encryption: 'tls',
    auth: 'app_password',
    mx_suffixes: ['yahoodns.net', 'yahoo.com', 'yahoo.co.jp'],
    note: '要在账号安全页生成"应用专用密码"，普通登录密码不行。',
    help_url: 'https://help.yahoo.com/kb/SLN15241.html',
  },
]

export function presetById(id: string): MailboxPreset | undefined {
  return MAILBOX_PRESETS.find((p) => p.id === id)
}

/** 邮箱地址的域名部分（小写）；不像地址就回 undefined。 */
export function domainOfEmail(email: string): string | undefined {
  const at = email.lastIndexOf('@')
  if (at <= 0) return undefined
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  return domain.includes('.') && !domain.endsWith('.') ? domain : undefined
}

/**
 * MX 目标 → 预设。
 *
 * 记录按优先级从小到大试（优先级最小的那台才是信真正去的地方，
 * 一条留着没删的旧备份 MX 不该决定答案）。匹配是"等值或以 `.后缀` 结尾"，
 * 所以 `notqq.com` 不会被 `qq.com` 误命中。
 */
export function matchPresetByMx(
  records: readonly { priority: number; exchange: string }[],
): MailboxPreset | undefined {
  const ordered = [...records].sort((a, b) => a.priority - b.priority)
  for (const record of ordered) {
    const host = record.exchange.trim().toLowerCase().replace(/\.$/, '')
    if (host === '') continue
    for (const preset of MAILBOX_PRESETS) {
      if (preset.mx_suffixes.some((s) => host === s || host.endsWith(`.${s}`))) return preset
    }
  }
  return undefined
}

/** MX 查询的注入点（测试不联网）。 */
export type ResolveMx = (domain: string) => Promise<{ priority: number; exchange: string }[]>

export interface MailboxDetection {
  domain: string
  /** 按优先级排好的 MX 主机；给用户看"我们凭什么这么猜"。 */
  mx_hosts: string[]
  preset: MailboxPreset | undefined
}

/**
 * 先用第一个解析器查 MX；查不到或抛错就换第二个再查一次。
 * 代理的 fake-IP 模式下系统 DNS 常常只回 A 记录不回 MX，这时换公共 DNS 才识别得出"这是哪家邮箱"。
 * 只用于识别，不影响连接本身（连接仍走系统解析）。
 */
export function withMxFallback(primary: ResolveMx, fallback: ResolveMx): ResolveMx {
  return async (domain) => {
    try {
      const records = await primary(domain)
      if (records.length > 0) return records
    } catch {
      // 落到备用解析器
    }
    return fallback(domain)
  }
}

export const PUBLIC_DNS_SERVERS = ['223.5.5.5', '1.1.1.1'] as const

async function systemThenPublicDns(): Promise<ResolveMx> {
  const dns = await import('node:dns/promises')
  const resolver = new dns.Resolver()
  resolver.setServers([...PUBLIC_DNS_SERVERS])
  return withMxFallback(
    (d) => dns.resolveMx(d),
    (d) => resolver.resolveMx(d),
  )
}

export async function detectMailbox(email: string, resolve?: ResolveMx): Promise<MailboxDetection> {
  const domain = domainOfEmail(email)
  if (domain === undefined) return { domain: '', mx_hosts: [], preset: undefined }
  try {
    const resolveMx = resolve ?? (await systemThenPublicDns())
    const records = await resolveMx(domain)
    return {
      domain,
      mx_hosts: [...records]
        .sort((a, b) => a.priority - b.priority)
        .map((r) => r.exchange.replace(/\.$/, '')),
      // 查得到 MX 就以 MX 为准；查不到（DNS 不通 / 这台机器不让查）再看域名本身
      preset: matchPresetByMx(records) ?? matchPresetByDomain(domain),
    }
  } catch {
    // DNS 整个不通：个人邮箱的域名本身就是答案，别让用户对着空表单发呆
    return { domain, mx_hosts: [], preset: matchPresetByDomain(domain) }
  }
}

/**
 * 只按**域名**认（不查网）。
 *
 * 为什么要有它：`me@163.com`、`me@qq.com`、`me@icloud.com` 这种个人邮箱，域名本身
 * 已经是确定答案了——公司网络禁了对外 DNS、或者临时查不到 MX 的时候，
 * 没理由让用户对着一张空表单自己去查 IMAP 主机端口。
 *
 * 企业域名不会误命中：它匹配的是预设自己的 `mx_suffixes`，而那几条列的都是
 * 各家自己的域名，一家企业的自有域名不可能等于 `qq.com` / `163.com`。
 */
export function matchPresetByDomain(domain: string): MailboxPreset | undefined {
  const host = domain.trim().toLowerCase().replace(/\.$/, '')
  if (host === '') return undefined
  return MAILBOX_PRESETS.find((p) => p.mx_suffixes.some((s) => host === s))
}

// ── 错误 → 人话 ────────────────────────────────────────────────────────

/** 一条失败的分类结果。`detail` 是上游原文，`message` 才是给用户看的。 */
export interface MailFailure {
  reason: MailFailureReason
  message: string
  detail: string
}

export type MailFailureReason =
  | 'bad_credentials'
  | 'app_password_required'
  | 'host_not_found'
  | 'unreachable'
  | 'timeout'
  | 'tls_failed'
  | 'imap_disabled'
  | 'oauth_required'
  | 'imap_failed'
  | 'smtp_failed'

/**
 * IMAP / SMTP 的失败原文 → 原因码 + 中文人话。
 *
 * 为什么值得单独做：`AUTHENTICATIONFAILED` 这一个词底下藏着两件完全不同的事——
 * "密码打错了"和"你用了登录密码，但这家邮箱只认授权码"。后者是国内邮箱最常见的
 * 第一次失败，而报错原文一个字都不会提"授权码"。所以命中 163 / QQ / Gmail 这类
 * 要授权码的主机时，直接把话说到位。
 *
 * @param detail 上游原文（`imap: ...` / `smtp: ...`）。
 * @param side   哪一头失败的。
 * @param host   这次用的主机名；用来判断"是不是那家要授权码的"。
 */
export function classifyMailFailure(
  detail: string,
  side: 'imap' | 'smtp',
  host?: string,
): MailFailure {
  const text = detail.toLowerCase()
  const wrap = (reason: MailFailureReason, message: string): MailFailure => ({
    reason,
    message,
    detail,
  })

  if (
    /xoauth2|oauth|basic authentication is disabled|authentication unsuccessful.*basic/.test(text)
  )
    return wrap(
      'oauth_required',
      '这家邮箱已经不允许用密码收发信了，要走授权登录——这一版还没做，下一版补上。',
    )

  const authFailed =
    /authenticationfailed|invalid credentials|login failed|auth.*fail|535|eauth|invalid user|username and password not accepted/.test(
      text,
    )
  if (authFailed) {
    if (needsAppPassword(host)) {
      return wrap(
        'app_password_required',
        '要用"授权码"，不是你平时登录邮箱的那个密码。' +
          '去邮箱网页版的设置里开启 IMAP/SMTP 服务，生成一串授权码再填进来。',
      )
    }
    return wrap('bad_credentials', '密码或授权码不对。核对一下重新填一次——前后别带空格。')
  }

  if (/enotfound|getaddrinfo|eai_again|dns/.test(text))
    return wrap('host_not_found', '找不到这台服务器：收信 / 发信地址可能写错了一个字。')

  if (/imap.*(disabled|not enabled)|service.*not.*(open|enabled)|请先开启/.test(text))
    return wrap('imap_disabled', '这个邮箱还没开 IMAP 服务，先去网页版的设置里打开它。')

  if (/econnrefused|ehostunreach|enetunreach|econnreset/.test(text))
    return wrap(
      'unreachable',
      '主机或端口不对，或者这个邮箱没开 IMAP。收信一般是 993，发信 465（少数是 587）。',
    )

  if (/timeout|etimedout|eenvelope.*timeout/.test(text))
    return wrap('timeout', '等太久没有回应：多半是端口填错了，或者这台电脑上不去这个服务器。')

  if (/cert|tls|ssl|self.signed|wrong version number/.test(text))
    return wrap('tls_failed', '加密握手没成功：端口可能填错了（收信 993，发信 465 或 587）。')

  if (/eenvelope|mailbox.*unavailable|relay.*denied/.test(text))
    return wrap(
      'smtp_failed',
      '发信被拒了：这个账号可能没有发信权限，或者发件地址和登录账号不一致。',
    )

  return wrap(
    side === 'imap' ? 'imap_failed' : 'smtp_failed',
    side === 'imap' ? '收信没连上，原因见下面那行。' : '发信没连上，原因见下面那行。',
  )
}

/** 这台主机属不属于"必须用授权码"的那几家。 */
function needsAppPassword(host: string | undefined): boolean {
  if (host === undefined || host === '') return false
  const h = host.trim().toLowerCase()
  return MAILBOX_PRESETS.some(
    (p) =>
      p.auth === 'app_password' &&
      (h === p.imap_host || h === p.smtp_host || suffixHit(h, p.mx_suffixes)),
  )
}

function suffixHit(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`))
}
