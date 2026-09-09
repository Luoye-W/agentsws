/**
 * WP20：邮箱口令的来源多了一条——本机加密秘密库（按连接 id 取），
 * 原来的环境变量那条照旧。改的只有"读凭据"这一处，收发信逻辑没动。
 */
import { describe, expect, it } from 'vitest'
import type { CredentialSource, ImapClientLike, TransportLike } from '../src/index.js'
import { ChannelError, ImapMailSource, readPassword, SmtpMailer } from '../src/index.js'

const PASSWORD = 'app-specific-Kq3-from-the-vault'

const vault = (map: Record<string, string>): CredentialSource => ({
  password: ({ connection_id }) => {
    const hit = map[connection_id]
    if (hit === undefined)
      throw new ChannelError('unauthenticated', `没有这条连接：${connection_id}`)
    return hit
  },
})

function fakeImap(seen: { password?: string }): (c: unknown, p: string) => ImapClientLike {
  return (_config, password) => {
    seen.password = password
    return {
      connect: async () => {},
      logout: async () => {},
      close: () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      fetch: () => ({
        async *[Symbol.asyncIterator]() {
          // 不吐任何邮件
        },
      }),
    }
  }
}

function fakeTransport(): () => TransportLike {
  return () => ({
    sendMail: async () => ({ messageId: '<x@y>' }),
    verify: async () => true,
    close: () => {},
  })
}

describe('readPassword：口令读取的唯一入口', () => {
  it('connection_id 优先走秘密库', () => {
    expect(readPassword({ connection_id: 'conn_1' }, {}, vault({ conn_1: PASSWORD }))).toBe(
      PASSWORD,
    )
  })

  it('没有 connection_id 就退回环境变量', () => {
    expect(readPassword({ password_env: 'MAIL_PW' }, { MAIL_PW: 'from-env' })).toBe('from-env')
  })

  it('环境变量没设就抛，不返回空串', () => {
    expect(() => readPassword({ password_env: 'MAIL_PW' }, {})).toThrow(ChannelError)
  })

  it('要 connection_id 却没装配秘密库：明确报错', () => {
    try {
      readPassword({ connection_id: 'conn_1' }, {})
      expect.unreachable('没有 CredentialSource 时不该拿到口令')
    } catch (e) {
      expect(e).toBeInstanceOf(ChannelError)
      expect((e as ChannelError).code).toBe('unauthenticated')
    }
  })

  it('两条都没有就返回 undefined（本地无鉴权 SMTP 桩）', () => {
    expect(readPassword({}, {})).toBeUndefined()
  })
})

describe('IMAP / SMTP 从秘密库取口令', () => {
  it('IMAP：连接 id 拿到的就是库里那一份，配置对象里没有口令', async () => {
    const seen: { password?: string } = {}
    const config = {
      host: '127.0.0.1',
      port: 993,
      secure: true,
      user: 'a@b.com',
      connection_id: 'conn_1',
    }
    const source = new ImapMailSource({
      config,
      createClient: fakeImap(seen),
      credentials: vault({ conn_1: PASSWORD }),
    })
    expect(await source.health()).toEqual({ ok: true })
    expect(seen.password).toBe(PASSWORD)
    expect(JSON.stringify(config)).not.toContain(PASSWORD)
  })

  it('IMAP：秘密库里没有这条连接 → health 回 false，不抛穿', async () => {
    const source = new ImapMailSource({
      config: {
        host: '127.0.0.1',
        port: 993,
        secure: true,
        user: 'a@b.com',
        connection_id: 'conn_missing',
      },
      createClient: fakeImap({}),
      credentials: vault({}),
    })
    const health = await source.health()
    expect(health.ok).toBe(false)
  })

  it('IMAP：既没有 connection_id 也没有 password_env → 说清楚缺什么', async () => {
    const source = new ImapMailSource({
      config: { host: '127.0.0.1', port: 993, secure: true, user: 'a@b.com' },
      createClient: fakeImap({}),
    })
    const health = await source.health()
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('connection_id')
  })

  it('SMTP：同一条秘密库路径', async () => {
    const seen: { password?: string | undefined } = {}
    const mailer = new SmtpMailer({
      config: {
        host: '127.0.0.1',
        port: 465,
        secure: true,
        user: 'a@b.com',
        connection_id: 'conn_1',
      },
      createTransport: (_c, p) => {
        seen.password = p
        return fakeTransport()()
      },
      credentials: vault({ conn_1: PASSWORD }),
    })
    expect(await mailer.health()).toEqual({ ok: true })
    expect(seen.password).toBe(PASSWORD)
    await mailer.close()
  })

  it('SMTP：两条来源都没有 = 无鉴权（本地桩照旧能用）', async () => {
    const seen: { password?: string | undefined } = { password: 'sentinel' }
    const mailer = new SmtpMailer({
      config: { host: '127.0.0.1', port: 1025, secure: false },
      createTransport: (_c, p) => {
        seen.password = p
        return fakeTransport()()
      },
    })
    expect(await mailer.health()).toEqual({ ok: true })
    expect(seen.password).toBeUndefined()
    await mailer.close()
  })
})
