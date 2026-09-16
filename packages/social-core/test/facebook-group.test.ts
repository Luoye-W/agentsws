/**
 * WP73（56 §6 第二项）：**Facebook 群组的浏览器模式接上执行器**。
 *
 * 没有真 Facebook 账号能验，所以这里用一个**假的执行器**（注入），把三条钉死：
 *
 * 1. **读走白名单**：只读动作真去开页面，但开之前先查域名；越界的一个字都不开。
 * 2. **写先出卡**：五个写口子永远回 `browser_required`，**一跳都不点**；
 *    真去点要拿着批过的卡 id 走 `executeApprovedBrowserAction`。
 * 3. **失效即停**：执行器回 `handover`（登录态掉了 / 页面改版了）就停下来说
 *    "请你接管"，**不重试**。
 *
 * 外加一条一致性：适配器自己那份白名单与职责 yml 的 `browser_scope` 是同一份
 * （两处都写是有意的——yml 那份是真闸，这一份是第二道；对不上就在这里喊）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type BrowserAction,
  type BrowserExecutor,
  type BrowserRunResult,
  createFacebookGroupAdapter,
  executeApprovedBrowserAction,
  FACEBOOK_GROUP_HOSTS,
  memberDecisionScript,
  publishScript,
  type SocialTransport,
} from '../src/index.js'

const NOW = '2026-09-16T02:00:00.000Z'

const transport: SocialTransport = {
  connected: () => true,
  now: () => NOW,
  // 浏览器模式碰不到凭据：登录态在用户自己那个 Chrome 里（13 §4）
  credential: async () => {
    throw new Error('浏览器模式不该取凭据')
  },
  fetch: async () => {
    throw new Error('浏览器模式不该打 HTTP')
  },
}

/** 假执行器：记下被要求做了什么，按剧本回三种结果之一。 */
function fakeExecutor(
  script: (action: BrowserAction) => BrowserRunResult,
  hosts?: readonly string[],
): BrowserExecutor & { ran: BrowserAction[] } {
  const ran: BrowserAction[] = []
  return {
    ran,
    ...(hosts === undefined ? {} : { allowedHosts: () => hosts }),
    run: async (action) => {
      ran.push(action)
      return script(action)
    },
  }
}

function asError(r: { ok: boolean }): { reason: string; message: string } {
  if (r.ok) throw new Error('本该失败，却成功了')
  return r as unknown as { reason: string; message: string }
}
function asOk<T>(r: { ok: boolean }): { data: T } {
  if (!r.ok) throw new Error(`本该成功，却失败了：${JSON.stringify(r)}`)
  return r as unknown as { data: T }
}

describe('Facebook 群组：读走白名单（WP73 / 55 §3）', () => {
  it('待审入群真去开"成员申请"页，读回来的每条都带答案原文', async () => {
    const exec = fakeExecutor(() => ({
      status: 'ok',
      items: [
        {
          external_id: 'u_1001',
          handle: 'deskhero',
          display_name: 'Desk Hero',
          applied_at: '2026-09-16T00:00:00.000Z',
          application_answers: ['在用 Nordvolt 的 65W'],
        },
      ],
    }))
    const a = createFacebookGroupAdapter(transport, { browser: exec })
    const r = asOk<{ external_id: string; status: string; application_answers?: string[] }[]>(
      await (a.members as NonNullable<typeof a.members>)({
        account_external_id: 'nordvolt-desk',
        status: 'pending',
      }),
    )
    expect(exec.ran[0]?.url).toBe('https://www.facebook.com/groups/nordvolt-desk/member-requests')
    // 读动作 = `writes: false`（它决定这一步要不要先过审批）
    expect(exec.ran[0]?.writes).toBe(false)
    expect(r.data[0]?.status).toBe('pending')
    expect(r.data[0]?.application_answers).toEqual(['在用 Nordvolt 的 65W'])
  })

  it('白名单之外的地址一个字都不开（执行器根本没被调到）', async () => {
    const exec = fakeExecutor(() => ({ status: 'ok', items: [] }), ['*.example.com'])
    const a = createFacebookGroupAdapter(transport, { browser: exec })
    const r = asError(
      await (a.posts as NonNullable<typeof a.posts>)({ account_external_id: 'nordvolt-desk' }),
    )
    expect(r.reason).toBe('browser_required')
    expect(r.message).toContain('不在这条职责能开的站里')
    expect(exec.ran).toHaveLength(0)
  })

  it('没装执行器 = 还是 WP72 那个样子（只出脚本描述，不假装读到了）', async () => {
    const a = createFacebookGroupAdapter(transport)
    const r = asError(
      await (a.posts as NonNullable<typeof a.posts>)({ account_external_id: 'nordvolt-desk' }),
    )
    expect(r.reason).toBe('browser_required')
    expect(r.message).toContain('受控浏览器')
  })

  it('整份成员名单我们没接：照实说，不去翻几百屏', async () => {
    const exec = fakeExecutor(() => ({ status: 'ok', items: [] }))
    const a = createFacebookGroupAdapter(transport, { browser: exec })
    const r = asError(
      await (a.members as NonNullable<typeof a.members>)({
        account_external_id: 'g1',
        status: 'active',
      }),
    )
    expect(r.reason).toBe('browser_required')
    expect(exec.ran).toHaveLength(0)
  })
})

describe('Facebook 群组：写先出卡（WP73 纪律 2）', () => {
  it('五个写口子一个都不点，只回 browser_required', async () => {
    const exec = fakeExecutor(() => ({ status: 'ok' }))
    const a = createFacebookGroupAdapter(transport, { browser: exec })
    const results = [
      await (a.publish as NonNullable<typeof a.publish>)({
        account_external_id: 'g1',
        kind: 'post',
        body: '本周聚会',
      }),
      await (a.reply as NonNullable<typeof a.reply>)({ parent_external_id: 'p1', text: '收到' }),
      await (a.decideMember as NonNullable<typeof a.decideMember>)({
        account_external_id: 'g1',
        member_external_id: 'u1',
        decision: 'approve',
      }),
      await (a.broadcast as NonNullable<typeof a.broadcast>)({
        account_external_id: 'g1',
        body: '公告',
      }),
      await (a.moderate as NonNullable<typeof a.moderate>)({
        account_external_id: 'g1',
        target_external_id: 'p9',
        action: 'delete_post',
      }),
    ]
    for (const r of results) expect(asError(r).reason).toBe('browser_required')
    // **一跳都没点**：浏览器只是手，不是授权
    expect(exec.ran).toHaveLength(0)
  })

  it('批准之后才点，而且没有卡 id 就不点', async () => {
    const exec = fakeExecutor(() => ({ status: 'ok', verified: true }))
    const action = publishScript({ account_external_id: 'g1', kind: 'post', body: '本周聚会' })
    expect(action.writes).toBe(true)

    const noCard = asError(
      await executeApprovedBrowserAction(exec, action, { approval_id: '', now: NOW }),
    )
    expect(noCard.reason).toBe('needs_approval')
    expect(exec.ran).toHaveLength(0)

    const done = asOk<{ verified: boolean }>(
      await executeApprovedBrowserAction(exec, action, { approval_id: 'ap_1', now: NOW }),
    )
    expect(done.data.verified).toBe(true)
    expect(exec.ran).toHaveLength(1)
  })

  it('执行器说不准做成没有（`verified` 为假）就照实报，不当成成功', async () => {
    const exec = fakeExecutor(() => ({ status: 'ok' }))
    const r = asOk<{ verified: boolean }>(
      await executeApprovedBrowserAction(
        exec,
        memberDecisionScript({
          account_external_id: 'g1',
          member_external_id: 'u1',
          decision: 'approve',
        }),
        { approval_id: 'ap_2', now: NOW },
      ),
    )
    expect(r.data.verified).toBe(false)
  })
})

describe('Facebook 群组：失效即停（WP73 纪律 3）', () => {
  it('登录态掉了 → 一句"请你接管" + **不重试**', async () => {
    const exec = fakeExecutor(() => ({
      status: 'handover',
      message: '打开群页面之后跳到了登录页。',
    }))
    const a = createFacebookGroupAdapter(transport, { browser: exec })
    const r = asError(await (a.posts as NonNullable<typeof a.posts>)({ account_external_id: 'g1' }))
    expect(r.reason).toBe('browser_required')
    expect(r.message).toContain('要你自己在浏览器里接一下')
    expect(r.message).toContain('没有重试')
    expect(exec.ran).toHaveLength(1)
  })

  it('写动作被批了之后遇到改版，也是停下来问人，不硬点', async () => {
    const exec = fakeExecutor(() => ({
      status: 'handover',
      message: '发帖框的位置和以前不一样了，找不到"定时发布"。',
    }))
    const r = asError(
      await executeApprovedBrowserAction(
        exec,
        publishScript({ account_external_id: 'g1', kind: 'post', body: 'x' }),
        { approval_id: 'ap_3', now: NOW },
      ),
    )
    expect(r.message).toContain('要你自己在浏览器里接一下')
    expect(exec.ran).toHaveLength(1)
  })

  it('`failed` 与 `handover` 是两句话（后者才要人去接管）', async () => {
    const exec = fakeExecutor(() => ({ status: 'failed', message: '网络断了' }))
    const a = createFacebookGroupAdapter(transport, { browser: exec })
    const r = asError(await (a.posts as NonNullable<typeof a.posts>)({ account_external_id: 'g1' }))
    expect(r.reason).toBe('upstream_error')
    expect(r.message).not.toContain('要你自己在浏览器里接一下')
  })
})

describe('白名单两处写的是同一份', () => {
  it('`social/facebook-group.yml` 的 browser_scope 与 FACEBOOK_GROUP_HOSTS 对得上', () => {
    const yml = readFileSync(
      join(import.meta.dirname, '../../roles/roles/social/facebook-group.yml'),
      'utf8',
    )
    const block = /\nbrowser_scope:\n((?:\s+-\s+.*\n)+)/.exec(yml)?.[1] ?? ''
    const hosts = block
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*-\s*/, '')
          .trim()
          .replace(/^'|'$/g, ''),
      )
      .filter((x) => x !== '')
    expect(hosts).toEqual([...FACEBOOK_GROUP_HOSTS])
  })
})
