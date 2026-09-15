/**
 * 20 §1–§3 本地档身份服务的**契约一致性套件**：接受任意实现，
 * 对内存档与 SQLite 档各跑一遍。两档之间的任何漂移都应该在这里露出来。
 */
import type { Clock } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalIdentityService } from '../src/identity.js'

export interface TestClock extends Clock {
  advance(ms: number): void
}

export function testClock(start = '2026-09-07T09:00:00.000Z'): TestClock {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance(ms: number) {
      t += ms
    },
  }
}

/** 确定性伪随机（seed 注入，不用 Math.random）。 */
export function seeded(seed = 42): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface IdentityHarness {
  name: string
  /** 每个用例一份全新实例。 */
  make(opts: { clock: Clock; random: () => number }): LocalIdentityService
  dispose?(svc: LocalIdentityService): void
}

export function runIdentityConformance(h: IdentityHarness): void {
  const live: LocalIdentityService[] = []
  let clock = testClock()
  const make = (): LocalIdentityService => {
    const s = h.make({ clock, random: seeded(7) })
    live.push(s)
    return s
  }
  const seed = async (): Promise<{
    svc: LocalIdentityService
    person: Awaited<ReturnType<LocalIdentityService['createPerson']>>
    workspace: Awaited<ReturnType<LocalIdentityService['createWorkspace']>>
  }> => {
    const svc = make()
    const person = await svc.createPerson({ email: 'Owner@Example.com', name: 'Owner' })
    const workspace = await svc.createWorkspace({
      name: 'default',
      owner_id: person.id,
      kind: 'personal',
    })
    return { svc, person, workspace }
  }

  afterEach(() => {
    for (const s of live.splice(0)) h.dispose?.(s)
    clock = testClock()
  })

  describe(`IdentityService 契约一致性 · ${h.name}`, () => {
    // ── 人
    it('createPerson：邮箱统一小写去空白，带一条 local identity', async () => {
      const svc = make()
      const p = await svc.createPerson({ email: '  Owner@Example.COM ', name: 'Owner' })
      expect(p.email).toBe('owner@example.com')
      expect(p.identities[0]).toMatchObject({ provider: 'local', external_id: 'owner@example.com' })
      expect(p.created_at).toBe(clock.now())
      expect(await svc.getPerson(p.id)).toEqual(p)
      expect(await svc.getPerson('per_missing')).toBeUndefined()
    })

    it('createPerson：同邮箱再建返回同一个人（不重复建）', async () => {
      const svc = make()
      const a = await svc.createPerson({ email: 'a@example.com', name: 'A' })
      const b = await svc.createPerson({ email: 'A@example.com', name: 'A2' })
      expect(b.id).toBe(a.id)
      expect(b.name).toBe('A')
    })

    it('createPerson：邮箱不合法直接拒', async () => {
      const svc = make()
      await expect(svc.createPerson({ email: '', name: 'x' })).rejects.toMatchObject({
        code: 'invalid_input',
      })
      await expect(svc.createPerson({ email: 'nope', name: 'x' })).rejects.toMatchObject({
        code: 'invalid_input',
      })
    })

    it('personByEmail：大小写与空白不敏感；查无此人返回 undefined', async () => {
      const { svc, person } = await seed()
      expect(svc.personByEmail(' OWNER@example.com ')?.id).toBe(person.id)
      expect(svc.personByEmail('nobody@example.com')).toBeUndefined()
    })

    // ── 工作区与成员
    it('createWorkspace：默认 tz / 币种 / 策略，owner 自动进成员表', async () => {
      const { svc, person, workspace } = await seed()
      expect(workspace.tz).toBe('Asia/Shanghai')
      expect(workspace.base_currency).toBe('USD')
      expect(workspace.owner_id).toBe(person.id)
      expect(workspace.policy.workspace_id).toBe(workspace.id)
      expect(await svc.getWorkspace(workspace.id)).toEqual(workspace)
      expect(await svc.getWorkspace('ws_missing')).toBeUndefined()
      const members = await svc.members(workspace.id)
      expect(members).toHaveLength(1)
      expect(members[0]).toMatchObject({ person_id: person.id, role: 'owner', ranges: [] })
    })

    it('createWorkspace：可覆盖 tz / 币种；owner 不存在或空名字直接拒', async () => {
      const { svc, person } = await seed()
      const ws = await svc.createWorkspace({
        name: 'cn',
        owner_id: person.id,
        kind: 'company',
        tz: 'UTC',
        base_currency: 'CNY',
      })
      expect(ws.tz).toBe('UTC')
      expect(ws.base_currency).toBe('CNY')
      await expect(
        svc.createWorkspace({ name: 'x', owner_id: 'per_missing', kind: 'personal' }),
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        svc.createWorkspace({ name: '  ', owner_id: person.id, kind: 'personal' }),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    })

    it('addMember：加人、重复加冲突、工作区 / 人不存在都拒', async () => {
      const { svc, workspace } = await seed()
      const other = await svc.createPerson({ email: 'b@example.com', name: 'B' })
      const m = await svc.addMember({
        workspace_id: workspace.id,
        person_id: other.id,
        role: 'member',
        ranges: [],
      })
      expect(m.joined_at).toBe(clock.now())
      expect(await svc.members(workspace.id)).toHaveLength(2)
      await expect(
        svc.addMember({
          workspace_id: workspace.id,
          person_id: other.id,
          role: 'member',
          ranges: [],
        }),
      ).rejects.toMatchObject({ code: 'conflict' })
      await expect(
        svc.addMember({
          workspace_id: 'ws_missing',
          person_id: other.id,
          role: 'member',
          ranges: [],
        }),
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        svc.addMember({
          workspace_id: workspace.id,
          person_id: 'per_missing',
          role: 'member',
          ranges: [],
        }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('members：不存在的工作区返回空数组', async () => {
      expect(await make().members('ws_missing')).toEqual([])
    })

    it('workspacesOf：只出在职的工作区；离职的不算', async () => {
      const { svc, person, workspace } = await seed()
      const second = await svc.createWorkspace({
        name: 'second',
        owner_id: person.id,
        kind: 'company',
      })
      expect(svc.workspacesOf(person.id).map((w) => w.id)).toEqual([workspace.id, second.id])
      const other = await svc.createPerson({ email: 'b@example.com', name: 'B' })
      expect(svc.workspacesOf(other.id)).toEqual([])
      await svc.addMember({
        workspace_id: workspace.id,
        person_id: other.id,
        role: 'member',
        ranges: [],
        left_at: clock.now(),
      })
      expect(svc.workspacesOf(other.id)).toEqual([])
    })

    // ── magic link（20 §2）
    it('issueLogin / verifyLogin：一次性，换出会话 token', async () => {
      const { svc, person } = await seed()
      const login = await svc.issueLogin('owner@example.com')
      expect(login.token.startsWith('ml_')).toBe(true)
      expect(Date.parse(login.expires_at)).toBeGreaterThan(Date.parse(clock.now()))
      const first = await svc.verifyLogin(login.token)
      expect(first?.person.id).toBe(person.id)
      expect(first?.session_token.startsWith('sess_')).toBe(true)
      // 一次性：第二次不认
      expect(await svc.verifyLogin(login.token)).toBeUndefined()
      const auth = await svc.authenticate(`Bearer ${first?.session_token ?? ''}`)
      expect(auth?.person_id).toBe(person.id)
    })

    it('issueLogin：未知邮箱直接拒', async () => {
      const { svc } = await seed()
      await expect(svc.issueLogin('nobody@example.com')).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    it('verifyLogin：过期不认；不存在的 token 不认', async () => {
      const { svc } = await seed()
      const login = await svc.issueLogin('owner@example.com')
      clock.advance(16 * 60 * 1000)
      expect(await svc.verifyLogin(login.token)).toBeUndefined()
      expect(await svc.verifyLogin('ml_nope')).toBeUndefined()
    })

    it('verifyLogin：没有工作区的人换不出会话', async () => {
      const svc = make()
      await svc.createPerson({ email: 'lonely@example.com', name: 'L' })
      const login = await svc.issueLogin('lonely@example.com')
      await expect(svc.verifyLogin(login.token)).rejects.toMatchObject({ code: 'not_found' })
    })

    // ── token 台账（20 §3）
    it('issue：四种 token 各有前缀，都绑 workspace，明文只回一次', async () => {
      const { svc, person, workspace } = await seed()
      for (const [kind, prefix] of [
        ['session', 'sess_'],
        ['api_key', 'key_'],
        ['runtime', 'rt_'],
        ['internal', 'int_'],
      ] as const) {
        const t = svc.issue(kind, person.id, workspace.id)
        expect(t.token.startsWith(prefix)).toBe(true)
        expect(t.workspace_id).toBe(workspace.id)
        expect(t.expires_at).toBeUndefined()
        expect(await svc.authenticate(t.token)).toEqual({
          person_id: person.id,
          workspace_id: workspace.id,
          kind,
        })
      }
    })

    it('issue：签发的 token 两两不同', async () => {
      const { svc, person, workspace } = await seed()
      const tokens = new Set(
        Array.from({ length: 8 }, () => svc.issue('api_key', person.id, workspace.id).token),
      )
      expect(tokens.size).toBe(8)
    })

    it('issue：带 ttl 的 token 到点失效', async () => {
      const { svc, person, workspace } = await seed()
      const t = svc.issue('runtime', person.id, workspace.id, 60_000)
      expect(t.expires_at).toBeDefined()
      expect(await svc.authenticate(t.token)).toBeDefined()
      clock.advance(60_000)
      expect(await svc.authenticate(t.token)).toBeUndefined()
    })

    it('issue：人 / 工作区不存在直接拒', async () => {
      const { svc, person, workspace } = await seed()
      expect(() => svc.issue('api_key', 'per_missing', workspace.id)).toThrow()
      expect(() => svc.issue('api_key', person.id, 'ws_missing')).toThrow()
    })

    it('revoke：撤销即刻失效；撤销不存在的 token 不抛', async () => {
      const { svc, person, workspace } = await seed()
      const t = svc.issue('api_key', person.id, workspace.id)
      svc.revoke(t.token)
      expect(await svc.authenticate(t.token)).toBeUndefined()
      expect(() => {
        svc.revoke('key_nope')
      }).not.toThrow()
    })

    it('authenticate：Bearer 前缀可有可无；空串与未知 token 一律不认', async () => {
      const { svc, person, workspace } = await seed()
      const t = svc.issue('session', person.id, workspace.id)
      expect(await svc.authenticate(t.token)).toBeDefined()
      expect(await svc.authenticate(`Bearer ${t.token}`)).toBeDefined()
      expect(await svc.authenticate('Bearer   ')).toBeUndefined()
      expect(await svc.authenticate('')).toBeUndefined()
      expect(await svc.authenticate('sess_unknown')).toBeUndefined()
    })

    // ── 52 O1 组织与品牌（WP65）────────────────────────────────────────

    it('createWorkspace：品牌名默认等于工作区名（52 O1）', async () => {
      const { workspace } = await seed()
      expect(workspace.brand?.name).toBe('default')
      expect(workspace.org_id).toBeUndefined()
    })

    it('一次性迁移：没挂组织的工作区建一个组织并回填品牌名；跑第二遍什么都不做', async () => {
      const { svc, person, workspace } = await seed()
      const first = await svc.migrateWorkspace({
        workspace_id: workspace.id,
        legal_name: '深圳诺伏特科技',
        domain: 'nordvolt.cn',
        discoverable: false,
      })
      expect(first.created).toBe(true)
      expect(first.organization.legal_name).toBe('深圳诺伏特科技')
      expect(first.organization.owner_id).toBe(person.id)
      expect(first.organization.discoverable).toBe(false)
      expect(first.workspace.org_id).toBe(first.organization.id)
      expect(first.workspace.brand?.name).toBe('default')
      // 幂等：第二遍不再建一个组织
      const again = await svc.migrateWorkspace({ workspace_id: workspace.id })
      expect(again.created).toBe(false)
      expect(again.organization.id).toBe(first.organization.id)
      expect(svc.listOrganizations()).toHaveLength(1)
    })

    it('没设过公司档案就用工作区名占位（迁移不许留一个空公司）', async () => {
      const { svc, workspace } = await seed()
      const migrated = await svc.migrateWorkspace({ workspace_id: workspace.id })
      expect(migrated.organization.legal_name).toBe('default')
      expect(migrated.organization.discoverable).toBe(true)
    })

    it('brandsOf：一个组织两个品牌；只回本人有成员资格的那几个（52 O2）', async () => {
      const { svc, person, workspace } = await seed()
      const org = (await svc.migrateWorkspace({ workspace_id: workspace.id })).organization
      const other = await svc.createPerson({ email: 'li@example.com', name: '李默' })
      await svc.addOrganizationMember({ org_id: org.id, person_id: other.id })
      const b = await svc.createWorkspace({
        name: '品牌乙',
        owner_id: person.id,
        kind: 'shared',
        org_id: org.id,
      })
      expect(
        svc
          .brandsOf(org.id)
          .map((w) => w.id)
          .sort(),
      ).toEqual([workspace.id, b.id].sort())
      // 李默进了公司但一个品牌都还没进（52 O3 明确要有的中间态）
      expect(svc.brandsOf(org.id, other.id)).toHaveLength(0)
      await svc.addMember({ workspace_id: b.id, person_id: other.id, role: 'member', ranges: [] })
      expect(svc.brandsOf(org.id, other.id).map((w) => w.id)).toEqual([b.id])
    })

    it('attachWorkspaceToOrg：挂一次就定了；挂到第二个组织下直接拒（45 H1 改写）', async () => {
      const { svc, person, workspace } = await seed()
      const a = await svc.createOrganization({ legal_name: 'A 公司', owner_id: person.id })
      const b = await svc.createOrganization({ legal_name: 'B 公司', owner_id: person.id })
      const attached = await svc.attachWorkspaceToOrg({ workspace_id: workspace.id, org_id: a.id })
      expect(attached.org_id).toBe(a.id)
      await expect(
        svc.attachWorkspaceToOrg({ workspace_id: workspace.id, org_id: b.id }),
      ).rejects.toThrow()
      // 挂到同一个组织下是幂等的
      await expect(
        svc.attachWorkspaceToOrg({ workspace_id: workspace.id, org_id: a.id }),
      ).resolves.toBeDefined()
    })

    it('离职一撤全撤：组织成员写 left_at，两个品牌的成员关系与 token 一起失效（40 E2）', async () => {
      const { svc, person, workspace } = await seed()
      const org = (await svc.migrateWorkspace({ workspace_id: workspace.id })).organization
      const li = await svc.createPerson({ email: 'li@example.com', name: '李默' })
      await svc.addOrganizationMember({ org_id: org.id, person_id: li.id })
      const b = await svc.createWorkspace({
        name: '品牌乙',
        owner_id: person.id,
        kind: 'shared',
        org_id: org.id,
      })
      for (const ws of [workspace.id, b.id])
        await svc.addMember({ workspace_id: ws, person_id: li.id, role: 'member', ranges: [] })
      const tokenA = svc.issue('session', li.id, workspace.id)
      const tokenB = svc.issue('session', li.id, b.id)

      const removed = await svc.removeOrganizationMember(org.id, li.id)
      expect(removed.brands.sort()).toEqual([workspace.id, b.id].sort())
      expect(removed.organization.members.find((m) => m.person_id === li.id)?.left_at).toBeDefined()
      // 不删行：名单上那一条还在，只是标了什么时候走的
      expect(removed.organization.members).toHaveLength(2)
      expect(svc.organizationsOf(li.id)).toHaveLength(0)
      expect(svc.brandsOf(org.id, li.id)).toHaveLength(0)
      expect(await svc.authenticate(tokenA.token)).toBeUndefined()
      expect(await svc.authenticate(tokenB.token)).toBeUndefined()
    })

    it('组织所有者不能被移除（要先转所有权）', async () => {
      const { svc, workspace } = await seed()
      const org = (await svc.migrateWorkspace({ workspace_id: workspace.id })).organization
      await expect(svc.removeOrganizationMember(org.id, org.owner_id)).rejects.toThrow()
    })

    it('改公司档案：空串域名 = 清掉；不给的字段一个都不动', async () => {
      const { svc, person } = await seed()
      const org = await svc.createOrganization({
        legal_name: '诺伏特',
        domain: 'nordvolt.cn',
        owner_id: person.id,
      })
      const renamed = await svc.updateOrganization(org.id, { legal_name: '诺伏特科技' })
      expect(renamed.legal_name).toBe('诺伏特科技')
      expect(renamed.domain).toBe('nordvolt.cn')
      expect(renamed.discoverable).toBe(true)
      const cleared = await svc.updateOrganization(org.id, { domain: '  ' })
      expect(cleared.domain).toBeUndefined()
      expect(cleared.legal_name).toBe('诺伏特科技')
    })

    it('setBrand：改品牌名不动工作区名；空名字直接拒', async () => {
      const { svc, workspace } = await seed()
      const next = await svc.setBrand(workspace.id, { name: '诺伏特户外' })
      expect(next.brand?.name).toBe('诺伏特户外')
      expect(next.name).toBe('default')
      await expect(svc.setBrand(workspace.id, { name: '  ' })).rejects.toThrow()
    })

    it('不存在的组织 / 工作区一律 not_found，不给探测的余地', async () => {
      const { svc, person } = await seed()
      expect(svc.getOrganization('org_nope')).toBeUndefined()
      await expect(
        svc.addOrganizationMember({ org_id: 'org_nope', person_id: person.id }),
      ).rejects.toThrow()
      await expect(
        svc.attachWorkspaceToOrg({ workspace_id: 'ws_nope', org_id: 'org_nope' }),
      ).rejects.toThrow()
    })
  })
}
