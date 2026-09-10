/**
 * 邮箱预设与自动识别（WP25 交付 B）。
 *
 * 三件事各一组：预设表每条的主机端口都对得上、MX 匹配按后缀规则走、
 * 失败原文翻成的中文是**用户照着能做下一步**的那一句。
 * 全程不联网：`detectMailbox` 的 DNS 由参数注入。
 */
import { describe, expect, it } from 'vitest'
import {
  classifyMailFailure,
  detectMailbox,
  domainOfEmail,
  MAILBOX_PRESETS,
  matchPresetByMx,
  presetById,
  withMxFallback,
} from '../src/email/presets.js'

describe('WP25 §B 预设表', () => {
  it('十家主流邮箱，id 不重复', () => {
    expect(MAILBOX_PRESETS).toHaveLength(10)
    expect(new Set(MAILBOX_PRESETS.map((p) => p.id)).size).toBe(10)
  })

  it('每条都有 IMAP / SMTP 主机、合法端口、加密方式、MX 后缀与一句人话', () => {
    for (const p of MAILBOX_PRESETS) {
      expect(p.imap_host, p.id).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      expect(p.smtp_host, p.id).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      expect([993, 143], p.id).toContain(p.imap_port)
      expect([465, 587, 25], p.id).toContain(p.smtp_port)
      expect(p.mx_suffixes.length, p.id).toBeGreaterThan(0)
      expect(p.note.length, p.id).toBeGreaterThan(10)
      // 587 一律 STARTTLS，465 / 993 一律隐式 TLS——填反了用户会看到"加密握手失败"
      expect(p.smtp_encryption, p.id).toBe(p.smtp_port === 587 ? 'starttls' : 'tls')
      expect(p.imap_encryption, p.id).toBe('tls')
    }
  })

  it('几条容易记错的主机端口，逐条钉死', () => {
    expect(presetById('qq')).toMatchObject({ imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' })
    expect(presetById('netease_163')).toMatchObject({
      imap_host: 'imap.163.com',
      smtp_host: 'smtp.163.com',
    })
    expect(presetById('tencent_exmail')).toMatchObject({
      imap_host: 'imap.exmail.qq.com',
      smtp_host: 'smtp.exmail.qq.com',
    })
    expect(presetById('aliyun_qiye')).toMatchObject({
      imap_host: 'imap.qiye.aliyun.com',
      smtp_host: 'smtp.qiye.aliyun.com',
    })
    // iCloud 与 Microsoft 是 587 STARTTLS，不是 465
    expect(presetById('icloud')?.smtp_port).toBe(587)
    expect(presetById('microsoft')?.smtp_port).toBe(587)
  })

  it('微软那条标 oauth_required，并且文案说清楚"这一版连不了"', () => {
    const ms = presetById('microsoft')
    expect(ms?.auth).toBe('oauth_required')
    expect(ms?.note).toContain('授权登录')
    // 别的都不该是 oauth_required——不然用户会以为哪家都连不了
    expect(MAILBOX_PRESETS.filter((p) => p.auth === 'oauth_required').map((p) => p.id)).toEqual([
      'microsoft',
    ])
  })

  it('要授权码的那几家，文案里必须出现"授权码"或"专用密码"', () => {
    for (const p of MAILBOX_PRESETS.filter((x) => x.auth === 'app_password')) {
      expect(p.note, p.id).toMatch(/授权码|专用密码|Application-Specific/)
    }
  })

  it('未知 id 回 undefined', () => {
    expect(presetById('nope')).toBeUndefined()
  })
})

describe('WP25 §B MX 匹配', () => {
  const mx = (exchange: string, priority = 10) => ({ priority, exchange })

  it('后缀等值命中', () => {
    expect(matchPresetByMx([mx('qq.com')])?.id).toBe('qq')
  })

  it('以 `.后缀` 结尾也命中（阿里企业邮的 MX 落在 mxhichina.com）', () => {
    expect(matchPresetByMx([mx('mx1.mxhichina.com')])?.id).toBe('aliyun_qiye')
    expect(matchPresetByMx([mx('acme-com.mail.protection.outlook.com')])?.id).toBe('microsoft')
    expect(matchPresetByMx([mx('aspmx.l.google.com')])?.id).toBe('google')
  })

  it('不是后缀边界就不算命中（notqq.com 不是 qq.com）', () => {
    expect(matchPresetByMx([mx('mail.notqq.com')])).toBeUndefined()
  })

  it('按优先级取：留着没删的旧备份 MX 不该决定答案', () => {
    expect(matchPresetByMx([mx('backup.qq.com', 50), mx('mx.qiye.163.com', 5)])?.id).toBe(
      'netease_qiye',
    )
  })

  it('企业自有域名指到 mxbiz1.qq.com：认成企业邮，而不是顺着 .qq.com 掉进个人邮', () => {
    expect(matchPresetByMx([mx('mxbiz1.qq.com', 5), mx('mxbiz2.qq.com', 10)])?.id).toBe(
      'tencent_exmail',
    )
  })

  it('163 / 126 个人邮的 MX 落在 mxmail.netease.com 上，也要认得出来', () => {
    expect(matchPresetByMx([mx('163mx00.mxmail.netease.com', 10)])?.id).toBe('netease_163')
  })

  it('腾讯企业邮排在 QQ 个人邮前面：exmail.qq.com 认成企业邮', () => {
    expect(matchPresetByMx([mx('mxbiz1.exmail.qq.com')])?.id).toBe('tencent_exmail')
  })

  it('末尾的点与大小写都归一', () => {
    expect(matchPresetByMx([mx('MX.QQ.COM.')])?.id).toBe('qq')
  })

  it('空清单 / 空主机名回 undefined', () => {
    expect(matchPresetByMx([])).toBeUndefined()
    expect(matchPresetByMx([mx('  ')])).toBeUndefined()
  })
})

describe('WP25 §B 域名与识别', () => {
  it('取域名：小写、去空格；不像地址回 undefined', () => {
    expect(domainOfEmail(' Support@Acme.COM ')).toBe('acme.com')
    expect(domainOfEmail('nope')).toBeUndefined()
    expect(domainOfEmail('@acme.com')).toBeUndefined()
    expect(domainOfEmail('a@localhost')).toBeUndefined()
    expect(domainOfEmail('a@acme.com.')).toBeUndefined()
  })

  it('识别到就回主机端口与 MX 依据', async () => {
    const found = await detectMailbox('support@acme.com', async () => [
      { priority: 10, exchange: 'mx2.mxhichina.com.' },
      { priority: 5, exchange: 'mx1.mxhichina.com.' },
    ])
    expect(found.domain).toBe('acme.com')
    expect(found.preset?.id).toBe('aliyun_qiye')
    // 末尾的点去掉，按优先级排好——界面要拿它告诉用户"我们凭什么这么猜"
    expect(found.mx_hosts).toEqual(['mx1.mxhichina.com', 'mx2.mxhichina.com'])
  })

  it('DNS 抛异常时不抛，回 preset: undefined', async () => {
    const found = await detectMailbox('a@self-hosted.example', () => {
      throw new Error('ENOTFOUND')
    })
    expect(found).toEqual({ domain: 'self-hosted.example', mx_hosts: [], preset: undefined })
  })

  it('DNS 返回 rejected promise 时也不抛', async () => {
    const found = await detectMailbox('a@acme.com', async () => {
      throw new Error('queryMx ESERVFAIL')
    })
    expect(found.preset).toBeUndefined()
  })

  it('主解析器查不到 MX（空或抛错）就换备用解析器；查到了就不再问备用', async () => {
    const zoho = [{ priority: 10, exchange: 'mx.zoho.com' }]
    let fallbackCalls = 0
    const fallback = async () => {
      fallbackCalls += 1
      return zoho
    }
    expect(await withMxFallback(async () => [], fallback)('kefuagents.com')).toEqual(zoho)
    expect(
      await withMxFallback(() => {
        throw new Error('ENODATA')
      }, fallback)('kefuagents.com'),
    ).toEqual(zoho)
    expect(fallbackCalls).toBe(2)
    const ali = [{ priority: 5, exchange: 'mx1.mxhichina.com' }]
    expect(await withMxFallback(async () => ali, fallback)('acme.com')).toEqual(ali)
    expect(fallbackCalls).toBe(2)
    // 备用也失败：异常往外抛，由 detectMailbox 兜住变成 preset: undefined
    const found = await detectMailbox(
      'a@x.example',
      withMxFallback(
        async () => [],
        () => {
          throw new Error('ETIMEOUT')
        },
      ),
    )
    expect(found.preset).toBeUndefined()
  })

  it('地址根本不像邮箱：连 DNS 都不查', async () => {
    let called = false
    const found = await detectMailbox('not-an-email', async () => {
      called = true
      return []
    })
    expect(called).toBe(false)
    expect(found).toEqual({ domain: '', mx_hosts: [], preset: undefined })
  })

  it('MX 有但一家都不认识：回 null 让界面回退手填', async () => {
    const found = await detectMailbox('a@acme.com', async () => [
      { priority: 10, exchange: 'mail.acme.com' },
    ])
    expect(found.preset).toBeUndefined()
    expect(found.mx_hosts).toEqual(['mail.acme.com'])
  })
})

describe('WP25 §B 失败原文 → 中文人话', () => {
  it('AUTHENTICATIONFAILED 在普通主机上是"密码不对"', () => {
    const f = classifyMailFailure('imap: AUTHENTICATIONFAILED', 'imap', 'mail.acme.com')
    expect(f.reason).toBe('bad_credentials')
    expect(f.message).toContain('密码或授权码不对')
  })

  it('同样一句话，落在 163 / QQ 上就是"要用授权码"', () => {
    for (const host of ['imap.163.com', 'smtp.qq.com', 'imap.gmail.com']) {
      const f = classifyMailFailure('LOGIN failed', 'imap', host)
      expect(f.reason, host).toBe('app_password_required')
      expect(f.message, host).toContain('授权码')
    }
  })

  it('Invalid credentials 也归到同一条', () => {
    expect(classifyMailFailure('Invalid credentials (Failure)', 'imap').reason).toBe(
      'bad_credentials',
    )
  })

  it('连接被拒 → "主机或端口不对，或邮箱没开 IMAP"', () => {
    const f = classifyMailFailure('connect ECONNREFUSED 127.0.0.1:1', 'imap', 'imap.qq.com')
    expect(f.reason).toBe('unreachable')
    expect(f.message).toContain('没开 IMAP')
  })

  it('超时 → 端口填错的提示', () => {
    expect(classifyMailFailure('Error: ETIMEDOUT', 'smtp').reason).toBe('timeout')
  })

  it('DNS 查不到 → 地址写错', () => {
    expect(classifyMailFailure('getaddrinfo ENOTFOUND imap.acmee.com', 'imap').reason).toBe(
      'host_not_found',
    )
  })

  it('TLS 握手失败 → 提示端口', () => {
    const f = classifyMailFailure('wrong version number', 'smtp')
    expect(f.reason).toBe('tls_failed')
    expect(f.message).toContain('993')
  })

  it('SMTP 的 EAUTH / EENVELOPE 各归各的', () => {
    expect(classifyMailFailure('EAUTH 535 5.7.8', 'smtp', 'smtp.acme.com').reason).toBe(
      'bad_credentials',
    )
    expect(classifyMailFailure('EENVELOPE Mailbox unavailable', 'smtp').reason).toBe('smtp_failed')
  })

  it('微软关掉基础认证的那句话认得出来', () => {
    const f = classifyMailFailure(
      'LOGIN failed: basic authentication is disabled',
      'imap',
      'outlook.office365.com',
    )
    expect(f.reason).toBe('oauth_required')
    expect(f.message).toContain('授权登录')
  })

  it('IMAP 没开的提示单独一条', () => {
    expect(
      classifyMailFailure('Unsafe Login. Please contact kefu@188.com 请先开启 IMAP', 'imap').reason,
    ).toBe('imap_disabled')
  })

  it('认不出来的原文兜底到 imap_failed / smtp_failed，原文进 detail', () => {
    const f = classifyMailFailure('something entirely new', 'imap')
    expect(f.reason).toBe('imap_failed')
    expect(f.detail).toBe('something entirely new')
    expect(classifyMailFailure('something entirely new', 'smtp').reason).toBe('smtp_failed')
  })
})
