/** 24 §5 技能与学习回路 API（v1 只开 resolved / personal overlay / lessons）。 */
import type { LessonRecord } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import { DuplicateAck, guardSimilar, recordCatalogNote } from './catalog.js'

const READ = { domain: 'skill', op: 'read', range: 'workspace', sensitivity: 'internal' } as const
const WRITE = { domain: 'skill', op: 'stage', range: 'workspace', sensitivity: 'internal' } as const

const LESSON_STATUS = ['pooled', 'proposed', 'accepted', 'ignored', 'refuted'] as const

const OverlayBody = z.object({
  ops: z
    .array(
      z.object({
        op: z.enum(['replace', 'append', 'remove']),
        section_id: z.string().min(1),
        body: z.string().optional(),
        origin: z.enum(['authored', 'learned']).optional(),
      }),
    )
    .min(1),
  base_version: z.string().min(1),
  version: z.number().int().nonnegative(),
  /**
   * 40 §2.2「建之前先查」。**只在第一次给自己开副本时查**（`version === 0`）：
   * 之后每次改自己的那份都弹一次选择题卡，那是骚扰不是帮忙。
   *
   * 查到的候选就是公司 / 部门层那一份同名技能——"要不要先看看公司版够不够用，
   * 真不够再自己开一份，并且说一句为什么"。
   */
  duplicate_ack: DuplicateAck.optional(),
})

const ExcludeBody = z.object({ excluded: z.boolean() })

/**
 * WP69（54 §3）：能单独看"记忆"的那四层。
 * `package` 是上游的（不是这家公司攒的），`personal` 在个人设置里看（40 E1：管理员没有读）。
 */
const MEMORY_TIERS = ['company', 'department', 'position', 'role'] as const

/**
 * WP71（36 §10）：手动加一条记忆。
 *
 * `tier` 只开这四层：包层是上游的、个人层在个人设置里改（40 E1 管理员没有读）。
 * 正文 2000 字封顶——记忆是"一句能照着做的规矩"，写成一篇文档就该进知识库（19）。
 */
const MemoryCreateBody = z.object({
  tier: z.enum(['company', 'department', 'position', 'role']),
  scope_id: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(2000),
  heading: z.string().min(1).max(120).optional(),
  skill: z.string().min(1).max(120).optional(),
})

const MemoryPatchBody = z.object({
  text: z.string().min(1).max(2000),
  heading: z.string().min(1).max(120).optional(),
})

const PromoteBody = z.object({
  section_ids: z.array(z.string().min(1)).min(1),
  /** WP69（54 §3）：四档。提到岗位 / 职责层要 `scope_id` 说清楚是哪一个。 */
  to_tier: z.enum(['company', 'department', 'position', 'role']),
  scope_id: z.string().min(1).optional(),
})

/**
 * WP71b：读一层记忆之前先问一句"这一层是不是我干活的那一层"。
 *
 * 装配没给 `memoryAccess`（老服务进程）时**不拦**——那时这条路由的行为与 WP71 一样，
 * 由处理函数后面的 `memory()` 自己决定回什么。新装配一律走这道门。
 */
async function assertMemoryRead(
  deps: GatewayDeps,
  input: {
    tier: (typeof MEMORY_TIERS)[number]
    scope_id?: string
    actor: { person_id: string; workspace_id: string }
  },
): Promise<void> {
  if (deps.skills.memoryAccess === undefined) return
  const verdict = await deps.skills.memoryAccess(input)
  if (!verdict.read) throw new ApiError('forbidden', verdict.reason ?? '看不了这一层的记忆')
}

export function skillRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/skills',
        operationId: 'listSkills',
        summary: '技能列表：当前版本、三层 overlay（人写的 / 学到的）、待审提案数（24 §5）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // WP71b：这条**只回本人自己那一份**（WP36 修掉了"端出每个人的个人层"那处泄漏），
        // 所以任何成员都读得。原来的 `skill.read@workspace` 在职责模板里根本不存在，
        // 效果是"除了 owner 谁都打不开技能页"——那是漏配，不是边界。
        authzBypass: () => true,
        params: [{ name: 'department', in: 'query', description: '部门 id（可选）' }],
        returns: 'SkillSummary[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.list === undefined) throw new ApiError('not_implemented', '技能面未装配')
        const department = c.req.query('department')
        return ok(
          c,
          await deps.skills.list({
            person_id: p.person_id,
            workspace_id: p.workspace_id,
            ...(department === undefined ? {} : { department_id: department }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/skills/proposals',
        operationId: 'listSkillProposals',
        summary: '待审的「昨天学到的」提案卡（不批不生效）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'SkillProposalSummary[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.proposals === undefined)
          throw new ApiError('not_implemented', '学习回路未装配')
        return ok(
          c,
          await deps.skills.proposals({ person_id: p.person_id, workspace_id: p.workspace_id }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/skills/:name/resolved',
        operationId: 'getResolvedSkill',
        summary: '按 actor 解析后的技能（包 → 公司 → 部门 → 个人，同段冲突不自动合）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        // WP71b：解析用的就是**调用者自己**的身份（`resolve(name, actor)`），
        // 回的是"我这次运行会吃到的那一份"。同上，任何成员都读得。
        authzBypass: () => true,
        params: [
          { name: 'name', in: 'path', required: true, description: '技能名' },
          { name: 'department', in: 'query', description: '部门 id（可选）' },
        ],
        returns: 'ResolvedSkill',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const department = c.req.query('department')
        const resolved = await deps.skills.resolve(param(c, 'name'), {
          person_id: p.person_id,
          workspace_id: p.workspace_id,
          ...(department === undefined ? {} : { department_id: department }),
        })
        if (!resolved) throw new ApiError('not_found', '技能不存在或已被本人排除')
        return ok(c, resolved)
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/skills/:name/overlay',
        operationId: 'putPersonalOverlay',
        summary: '写个人层 overlay（24 §5：这条路由只开个人层，tier / owner 由服务端定）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'name', in: 'path', required: true, description: '技能名' }],
        body: OverlayBody,
        returns: 'Overlay',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const input = await body(c, OverlayBody)
        const name = param(c, 'name')
        // 技能副本 = 第一次写个人层 overlay。已经有副本的（version > 0）不再拦
        const guard =
          input.version === 0
            ? await guardSimilar(deps, {
                workspace_id: p.workspace_id,
                kind: 'skill',
                title: name,
                target: `skill:${name}`,
                ...(input.duplicate_ack === undefined ? {} : { ack: input.duplicate_ack }),
              })
            : {}
        const overlay = await deps.skills.setOverlay({
          skill: name,
          tier: 'personal',
          owner: p.person_id,
          ops: input.ops.map((o) => ({
            op: o.op,
            section_id: o.section_id,
            ...(o.body === undefined ? {} : { body: o.body }),
            ...(o.origin === undefined ? {} : { origin: o.origin }),
          })),
          base_version: input.base_version,
          version: input.version,
        })
        await recordCatalogNote(deps, {
          workspace_id: p.workspace_id,
          entry_id: `skill:${name}`,
          guard,
        })
        return ok(c, overlay)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/skills/:name/exclude',
        operationId: 'excludeSkill',
        summary: '排除 / 取消排除某个技能（只影响本人，24 §2）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'name', in: 'path', required: true, description: '技能名' }],
        body: ExcludeBody,
        returns: '{ name, excluded }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.exclude === undefined) throw new ApiError('not_implemented', '技能面未装配')
        const input = await body(c, ExcludeBody)
        const name = param(c, 'name')
        await deps.skills.exclude(name, p.person_id, input.excluded)
        return ok(c, { name, excluded: input.excluded })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/skills/:name/promote',
        operationId: 'promoteSkill',
        summary: '把个人层的几段提上去：产出一条 skill_promotion 审批项（不落任何层）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        params: [{ name: 'name', in: 'path', required: true, description: '技能名' }],
        body: PromoteBody,
        returns: '{ accepted, approval_item_id?, reason? }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.promote === undefined) throw new ApiError('not_implemented', '技能面未装配')
        const input = await body(c, PromoteBody)
        return ok(
          c,
          await deps.skills.promote({
            skill: param(c, 'name'),
            section_ids: input.section_ids,
            to_tier: input.to_tier,
            ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
            actor: { person_id: p.person_id, workspace_id: p.workspace_id },
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/memory',
        operationId: 'getLayerMemory',
        summary:
          '某一层的记忆（54 §3）：岗位页的"记忆"tab 与职责层的"记忆"小节各列自己那一层（只读）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'tier',
            in: 'query',
            required: true,
            description: 'company | department | position | role',
          },
          { name: 'scope_id', in: 'query', description: '岗位 id / 职责 id / 部门 id' },
        ],
        returns: '{ tier, scope_id?, summary, entries }',
        /*
         * WP71b：**判定挪到处理函数里**（`deps.skills.memoryAccess`）。
         *
         * 元组判定答不了这条路由真正要问的问题——"这一层是不是我干活的那一层"，
         * 那要看 `tier` / `scope_id` 与本人名下的分配对不对得上，不是一个域上的读位。
         * 原来那条 `skill.read@workspace` 职责模板里没有，于是非 owner 一律 403
         * （WP71 在真 demo 上打出来的洞）。
         */
        authzBypass: () => true,
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.memory === undefined) throw new ApiError('not_implemented', '技能面未装配')
        const tier = c.req.query('tier') ?? ''
        if (!MEMORY_TIERS.includes(tier as (typeof MEMORY_TIERS)[number]))
          throw new ApiError('invalid_input', 'tier 只能是 company / department / position / role')
        const scope_id = c.req.query('scope_id')
        // WP71b：能不能看这一层，判据在服务端一份（与 can_edit 同源）
        await assertMemoryRead(deps, {
          tier: tier as (typeof MEMORY_TIERS)[number],
          ...(scope_id === undefined || scope_id === '' ? {} : { scope_id }),
          actor: { person_id: p.person_id, workspace_id: p.workspace_id },
        })
        const out = await deps.skills.memory({
          tier: tier as (typeof MEMORY_TIERS)[number],
          ...(scope_id === undefined || scope_id === '' ? {} : { scope_id }),
          actor: { person_id: p.person_id, workspace_id: p.workspace_id },
        })
        return ok(c, {
          tier,
          ...(scope_id === undefined || scope_id === '' ? {} : { scope_id }),
          ...out,
        })
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/memory',
        operationId: 'addMemoryEntry',
        summary: 'WP71（36 §10）手动往本层加一条记忆。越层一律 403——改得动哪一层，看你在哪一层干活',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        /*
         * WP71b：**判定挪进 `deps.skills.{add,update,delete}Memory`**（它们一律先过
         * `canEditMemory`）。理由与那条读一样：元组判定答不了"这一层是不是我干活的那一层"，
         * 而 `skill.stage@workspace` 职责模板里根本没有——留着它，"每条职责的记忆用户可手改"
         * 对**每一个非 owner** 都不成立（36 §10）。
         *
         * 收窄的部分一条没少：公司 / 部门层仍只有 owner 写得动，包层与个人层这条路不开。
         */
        authzBypass: () => true,
        body: MemoryCreateBody,
        returns: 'SkillMemoryEntry',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.addMemory === undefined)
          throw new ApiError('not_implemented', '记忆面未装配')
        const input = await body(c, MemoryCreateBody)
        return ok(
          c,
          await deps.skills.addMemory({
            tier: input.tier,
            ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
            text: input.text,
            ...(input.heading === undefined ? {} : { heading: input.heading }),
            ...(input.skill === undefined ? {} : { skill: input.skill }),
            actor: { person_id: p.person_id, workspace_id: p.workspace_id },
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'patch',
        path: '/v1/memory/:id',
        operationId: 'updateMemoryEntry',
        summary: 'WP71：改本层的一条记忆（正文，可带标题）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        /*
         * WP71b：**判定挪进 `deps.skills.{add,update,delete}Memory`**（它们一律先过
         * `canEditMemory`）。理由与那条读一样：元组判定答不了"这一层是不是我干活的那一层"，
         * 而 `skill.stage@workspace` 职责模板里根本没有——留着它，"每条职责的记忆用户可手改"
         * 对**每一个非 owner** 都不成立（36 §10）。
         *
         * 收窄的部分一条没少：公司 / 部门层仍只有 owner 写得动，包层与个人层这条路不开。
         */
        authzBypass: () => true,
        params: [{ name: 'id', in: 'path', required: true, description: '记忆条目 id' }],
        body: MemoryPatchBody,
        returns: 'SkillMemoryEntry',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.updateMemory === undefined)
          throw new ApiError('not_implemented', '记忆面未装配')
        const input = await body(c, MemoryPatchBody)
        return ok(
          c,
          await deps.skills.updateMemory({
            id: param(c, 'id'),
            text: input.text,
            ...(input.heading === undefined ? {} : { heading: input.heading }),
            actor: { person_id: p.person_id, workspace_id: p.workspace_id },
          }),
        )
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/memory/:id',
        operationId: 'deleteMemoryEntry',
        summary: 'WP71：删本层的一条记忆',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        /*
         * WP71b：**判定挪进 `deps.skills.{add,update,delete}Memory`**（它们一律先过
         * `canEditMemory`）。理由与那条读一样：元组判定答不了"这一层是不是我干活的那一层"，
         * 而 `skill.stage@workspace` 职责模板里根本没有——留着它，"每条职责的记忆用户可手改"
         * 对**每一个非 owner** 都不成立（36 §10）。
         *
         * 收窄的部分一条没少：公司 / 部门层仍只有 owner 写得动，包层与个人层这条路不开。
         */
        authzBypass: () => true,
        params: [{ name: 'id', in: 'path', required: true, description: '记忆条目 id' }],
        returns: '{ id, deleted }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        if (deps.skills.deleteMemory === undefined)
          throw new ApiError('not_implemented', '记忆面未装配')
        const id = param(c, 'id')
        await deps.skills.deleteMemory({
          id,
          actor: { person_id: p.person_id, workspace_id: p.workspace_id },
        })
        return ok(c, { id, deleted: true })
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/lessons',
        operationId: 'listLessons',
        summary: '教训池（只读；提议不自动写 overlay）',
        tag: 'skill',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'status', in: 'query', description: LESSON_STATUS.join(' | ') }],
        returns: 'LessonRecord[]',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const status = c.req.query('status')
        if (status !== undefined && !(LESSON_STATUS as readonly string[]).includes(status))
          throw new ApiError('invalid_input', 'status 不合法')
        return ok(
          c,
          await deps.skills.lessons({
            workspace_id: p.workspace_id,
            ...(status === undefined ? {} : { status: status as LessonRecord['status'] }),
          }),
        )
      },
    ),
  ]
}
