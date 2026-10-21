/**
 * WP440（docs/108 M9）：「消息渠道 → 每只邮箱」那一处——「有把握就直接回」开关 + 档位。
 * 缺省开、缺省适中（同在线客服）；档位只认「严格 / 适中 / 宽松」三种；落盘后重启还在。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MailboxSwitchStore } from '../src/mailbox-switches.js'

describe('WP440：邮箱上的「有把握就直接回」', () => {
  it('缺省开、缺省适中', () => {
    const s = new MailboxSwitchStore()
    expect(s.get('a@shop.example')).toMatchObject({
      auto_reply: true,
      auto_reply_strictness: 'balanced',
    })
  })

  it('关掉 / 改档位：只记真变了的；不认的档位不存', () => {
    const s = new MailboxSwitchStore()
    const off = s.set('a@shop.example', { auto_reply: false })
    expect(off.changed).toEqual(['auto_reply'])
    const strict = s.set('a@shop.example', { auto_reply_strictness: 'strict' })
    expect(strict.changed).toEqual(['auto_reply_strictness'])
    const junk = s.set('a@shop.example', {
      auto_reply_strictness: 'whatever' as unknown as 'strict',
    })
    expect(junk.changed).toEqual([])
    expect(s.get('A@Shop.example')).toMatchObject({
      auto_reply: false,
      auto_reply_strictness: 'strict',
    })
    // 别的邮箱不受影响
    expect(s.get('b@shop.example').auto_reply).toBe(true)
  })

  it('落盘：重启后还在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp440-mbx-'))
    try {
      new MailboxSwitchStore({ dir }).set('a@shop.example', {
        auto_reply: false,
        auto_reply_strictness: 'loose',
      })
      expect(new MailboxSwitchStore({ dir }).get('a@shop.example')).toMatchObject({
        auto_reply: false,
        auto_reply_strictness: 'loose',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
