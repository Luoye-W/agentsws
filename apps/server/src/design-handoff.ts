/**
 * WP421（自查 general 2.4，决策 1266–1270）：**设计需求单整条链的「交接」两头**。
 *
 * 自查发现：别的岗位下的需求单只落进一张表——不开事项、不通知设计岗（`design.request_created` 没有消费者）；
 * 设计岗出了图、人挑中了，结果也回不到下单的那件事上。这里只做这两头的「说一声」，不碰出图与定稿：
 *
 * 1. **建单** → 找做这条设计职责的人（没撤销的分配）：在他那条职责下开一件事（钉住这张单）、给他一条今天的待办；
 *    没人做就照实回「设计岗还没人做，这张单先排着」——不假装有人接了；
 * 2. **交付** → 下单那件事的时间线上说一句「设计岗交付了」（素材库能看到那一张）；设计岗那件事也记一句。
 */
import type { Assignment, DesignAsset, DesignRequest, MatterId } from '@agentsws/contracts'
import { designDutySpec } from '@agentsws/contracts'
import type { Work } from '@agentsws/work'

export interface DesignHandoffOptions {
  /** 工作模型（晚绑定：比设计那一摊晚建）。 */
  work(): Work | undefined
  /** 现在做这条职责的分配（没撤销的）。 */
  holders(role_id: string): readonly Assignment[]
  /** 职责 id → 中文名。 */
  roleName?(role_id: string): string | undefined
}

export interface DesignHandoff {
  onRequestCreated(request: DesignRequest): Promise<string | undefined>
  onDelivered(request: DesignRequest, asset: DesignAsset): Promise<void>
}

/** 设计岗那件事挂在哪条需求单上（事项钉的引用）。 */
const pinOf = (request_id: string) => ({ type: 'design_request', id: request_id })

export function createDesignHandoff(options: DesignHandoffOptions): DesignHandoff {
  const label = (role_id: string): string =>
    role_id === 'human' ? '人手动开的' : (options.roleName?.(role_id) ?? role_id)

  /** 设计岗那边为这张单开的那件事（按钉住的引用找；找不到 = 还没开）。 */
  const designMatterOf = (work: Work, request_id: string): MatterId | undefined =>
    work
      .listMatters({ kind: 'conversation' })
      .find((m) => m.context.pinned.some((p) => p.type === 'design_request' && p.id === request_id))
      ?.id

  return {
    async onRequestCreated(request) {
      const work = options.work()
      const spec = designDutySpec(request.duty)
      if (work === undefined || spec === undefined) return undefined
      const holder = options.holders(spec.role_id)[0]
      if (holder === undefined) {
        if (request.matter_id !== undefined && work.getMatter(request.matter_id as MatterId))
          work.appendEvent(request.matter_id as MatterId, {
            kind: 'note',
            text: `需求单「${request.title}」下了，但设计岗的「${spec.zh}」还没人做，这张单先排着。`,
            actor: { kind: 'agent', id: request.from_role_id },
          })
        return `设计岗的「${spec.zh}」还没人做，这张单先排着。`
      }
      if (designMatterOf(work, request.id) !== undefined) return undefined
      const matter = work.createMatter({
        kind: 'conversation',
        title: `设计需求单：${request.title}`,
        pinned: [pinOf(request.id)],
        position_id: holder.id,
        role_id: spec.role_id,
      })
      work.appendEvent(matter.id, {
        kind: 'note',
        text: `${label(request.from_role_id)}下了一张单：${request.need.slice(0, 300)}${request.due_at === undefined ? '' : `（${request.due_at.slice(0, 10)} 要）`}`,
        actor: { kind: 'agent', id: request.from_role_id },
      })
      work.createTodo({
        title: `设计需求单：${request.title}`,
        owner: holder.person_id,
        matter_id: matter.id,
        horizon: 'today',
        position_id: holder.id,
        ...(request.due_at === undefined ? {} : { due: request.due_at }),
      })
      if (request.matter_id !== undefined && work.getMatter(request.matter_id as MatterId))
        work.appendEvent(request.matter_id as MatterId, {
          kind: 'note',
          text: `需求单「${request.title}」交给设计岗的「${spec.zh}」了，出了图会回到这里。`,
          actor: { kind: 'agent', id: request.from_role_id },
        })
      return `设计岗的「${spec.zh}」收到了。`
    },

    async onDelivered(request, asset) {
      const work = options.work()
      if (work === undefined) return
      const text = `设计岗交付了「${request.title}」：定稿的那一张进了素材库（${asset.id}）。`
      if (request.matter_id !== undefined && work.getMatter(request.matter_id as MatterId))
        work.appendEvent(request.matter_id as MatterId, {
          kind: 'note',
          text,
          actor: { kind: 'agent', id: `design.${request.duty}` },
          ref: { type: 'design_asset', id: asset.id },
        })
      const own = designMatterOf(work, request.id)
      if (own !== undefined && own !== request.matter_id)
        work.appendEvent(own, {
          kind: 'note',
          text: `交付了，结果回给了${label(request.from_role_id)}。`,
          actor: { kind: 'agent', id: `design.${request.duty}` },
        })
    },
  }
}
