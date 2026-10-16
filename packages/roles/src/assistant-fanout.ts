/**
 * WP350（决策 900）：「我的助理」**一次拆成多份**——一段话 / 一份资料（会议记录、文档、聊天记录）里
 * 按岗位拆出「要做的事」「要记住的事」「个人偏好」，人在方案卡上确认后扇出。服务进程与模拟世界同一份判据。
 *
 * 拆（读懂那段话）是模型的事；这里只做**认岗位**与**改方案**两件确定性的事：
 *
 * 1. `resolveFanout`：模型给的每一条（带它猜的岗位名）→ 认到本人名下的岗位 / 职责（`pickDispatchTarget`
 *    同一把尺子：点了名照点、只提到一个才算、只有一个干活的岗位就归它）；认不出的标「归属待定」，**不猜**。
 *    要记的那条可以归「品牌公共」。像口令的那条不进知识、不进记忆（决策 814 的口令识别）。
 * 2. `applyFanoutEdits`：人在卡上勾掉 / 改归属 / 改文字之后，哪些真发、哪些不发（勾掉的、还待定的、像口令的）。
 *
 * 另有 `mentionedPositions`（话里点了几个岗位名——决策 861 放宽：点了多个就直接出多岗位方案卡）
 * 与 `fanoutNoteCard`（要记的那条写成 `proposed` 事实卡，出处 = 这份资料）。
 */
import type { FactCard, Iso8601, PersonId, WorkspaceId } from '@agentsws/contracts'
import { looksLikeSecretValue } from '@agentsws/contracts'
import { hasSecret, scrub } from '@agentsws/core'
import { type PickPosition, pickDispatchTarget, pickKey } from './assistant-pick.js'

export type FanoutKind = 'task' | 'note' | 'memory'

/** 模型拆出来的一条（还没认岗位）。 */
export interface FanoutDraftItem {
  kind: FanoutKind
  text: string
  /** 模型猜的岗位名；要记的那条写「品牌」= 品牌公共知识。 */
  position?: string
  duty?: string
  /** 一句为什么（要做的事）。 */
  why?: string
  /** 截止（有的话，原话）。 */
  due?: string
  /** 原文出处（资料里那一段）。 */
  quote?: string
}

/** 认过岗位的一条（方案卡上的一行）。 */
export interface FanoutItem {
  /** 卡内编号（`i1`…）。 */
  id: string
  kind: FanoutKind
  text: string
  why?: string
  due?: string
  quote?: string
  position_id?: string
  role_id?: string
  /** 要记的那条进品牌公共知识。 */
  brand?: true
  /** 归属待定：认不出岗位（候选是岗位 id）。 */
  unsure?: { reason: string; candidates: string[] }
  /** 像口令：不进知识 / 记忆。 */
  secret?: true
}

/** 人在方案卡上对一条的改动。 */
export interface FanoutEdit {
  id: string
  drop?: boolean
  position_id?: string
  role_id?: string
  /** 要记的那条改成品牌公共。 */
  brand?: boolean
  text?: string
}

/** 一张方案卡最多几条（再多就是一份长文档该分几次说了）。 */
export const FANOUT_MAX_ITEMS = 30
/** 一条的字数上限。 */
export const FANOUT_TEXT_MAX = 300
/** 出处原文一段的字数上限。 */
export const FANOUT_QUOTE_MAX = 400

/** 「品牌公共」的几种说法。 */
const BRAND = /^(品牌|公共|品牌公共|全品牌|全公司|公司|通用|brand|common|company)/iu

const clip = (s: string | undefined, n: number): string | undefined => {
  const one = (s ?? '').replace(/[ \t]+/g, ' ').trim()
  if (one === '') return undefined
  return one.length > n ? `${one.slice(0, n)}…` : one
}

const isGeneral = (p: PickPosition): boolean =>
  p.duties.length > 0 && p.duties.every((d) => d.role_id.startsWith('common.'))

/** 干活的岗位（候选就从这里出）。 */
const workingOf = (positions: readonly PickPosition[]): PickPosition[] =>
  positions.filter((p) => p.duties.length > 0 && !isGeneral(p))

/** 像不像夹着口令 / 密钥（决策 814 同一道）。 */
export function fanoutLooksSecret(text: string): boolean {
  return looksLikeSecretValue(text) || hasSecret(text)
}

/** 话里点名提到了哪几个岗位（岗位 id，按出现先后；只认全名，至少两个字）。 */
export function mentionedPositions(positions: readonly PickPosition[], text: string): string[] {
  const key = pickKey(text)
  return workingOf(positions)
    .map((p) => {
      const at = [p.name, ...(p.aliases ?? [])]
        .map(pickKey)
        .filter((k) => k.length >= 2)
        .map((k) => key.indexOf(k))
        .filter((i) => i >= 0)
      return { id: p.id, at: at.length === 0 ? -1 : Math.min(...at) }
    })
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.id)
}

export function resolveFanout(
  positions: readonly PickPosition[],
  drafts: readonly FanoutDraftItem[],
): FanoutItem[] {
  const working = workingOf(positions)
  const candidates = working.map((p) => p.id)
  const out: FanoutItem[] = []
  for (const d of drafts) {
    if (out.length >= FANOUT_MAX_ITEMS) break
    const text = clip(d.text, FANOUT_TEXT_MAX)
    if (text === undefined) continue
    const kind: FanoutKind = d.kind === 'note' || d.kind === 'memory' ? d.kind : 'task'
    const quote = clip(d.quote, FANOUT_QUOTE_MAX)
    const why = clip(d.why, 120)
    const due = clip(d.due, 40)
    const base: FanoutItem = {
      id: `i${out.length + 1}`,
      kind,
      text,
      ...(why === undefined ? {} : { why }),
      ...(due === undefined ? {} : { due }),
      ...(quote === undefined ? {} : { quote }),
    }
    if (kind === 'memory') {
      out.push(fanoutLooksSecret(`${text} ${quote ?? ''}`) ? { ...base, secret: true } : base)
      continue
    }
    if (kind === 'task') {
      // 要做的事交给岗位：口令一类的字先抹掉（岗位那边照样能做，只是看不到那串）
      base.text = scrub(base.text).text
      if (base.quote !== undefined) base.quote = scrub(base.quote).text
    } else if (fanoutLooksSecret(`${text} ${quote ?? ''}`)) {
      out.push({ ...base, secret: true })
      continue
    }
    const named = d.position?.trim() ?? ''
    if (kind === 'note' && named !== '' && BRAND.test(named)) {
      out.push({ ...base, brand: true })
      continue
    }
    const picked = pickDispatchTarget(positions, {
      text: named === '' ? text : '',
      ...(named === '' ? {} : { position: named }),
      ...(d.duty === undefined || d.duty.trim() === '' ? {} : { duty: d.duty }),
    })
    if (picked.ok && working.some((p) => p.id === picked.position_id)) {
      out.push({
        ...base,
        position_id: picked.position_id,
        ...(picked.role_id === undefined ? {} : { role_id: picked.role_id }),
      })
      continue
    }
    out.push({
      ...base,
      unsure: {
        reason: picked.ok ? '没看出该归哪个岗位' : picked.reason,
        candidates,
      },
    })
  }
  return out
}

/**
 * 人改过之后：`send` 是真要发的（要做的事都有岗位；要记的有岗位或品牌公共），
 * `skipped` 是不发的（勾掉的、还归属待定的、像口令的）。改归属只认本人名下的岗位 / 职责。
 */
export function applyFanoutEdits(
  positions: readonly PickPosition[],
  items: readonly FanoutItem[],
  edits: readonly FanoutEdit[] = [],
): {
  send: FanoutItem[]
  skipped: (FanoutItem & { why_skipped: 'dropped' | 'unsure' | 'secret' })[]
} {
  const working = workingOf(positions)
  const byId = new Map(edits.map((e) => [e.id, e]))
  const send: FanoutItem[] = []
  const skipped: (FanoutItem & { why_skipped: 'dropped' | 'unsure' | 'secret' })[] = []
  for (const item of items) {
    const e = byId.get(item.id)
    let next: FanoutItem = { ...item }
    if (e?.drop === true) {
      skipped.push({ ...next, why_skipped: 'dropped' })
      continue
    }
    const text = clip(e?.text, FANOUT_TEXT_MAX)
    if (text !== undefined) next.text = next.kind === 'task' ? scrub(text).text : text
    if (e?.brand === true && next.kind === 'note') {
      const { position_id: _p, role_id: _r, unsure: _u, ...rest } = next
      next = { ...rest, brand: true }
    } else if (e?.position_id !== undefined && next.kind !== 'memory') {
      const p = working.find((x) => x.id === e.position_id)
      if (p !== undefined) {
        const { brand: _b, unsure: _u, role_id: _r, ...rest } = next
        const role = p.duties.find((d) => d.role_id === e.role_id)?.role_id
        next = { ...rest, position_id: p.id, ...(role === undefined ? {} : { role_id: role }) }
      }
    }
    if (next.kind !== 'task' && (next.secret === true || fanoutLooksSecret(next.text))) {
      skipped.push({ ...next, secret: true, why_skipped: 'secret' })
      continue
    }
    const placed =
      next.kind === 'memory' ||
      (next.position_id !== undefined && working.some((p) => p.id === next.position_id)) ||
      (next.kind === 'note' && next.brand === true)
    if (!placed) {
      skipped.push({ ...next, why_skipped: 'unsure' })
      continue
    }
    send.push(next)
  }
  return { send, skipped }
}

/** 要记的那条写进知识库的样子（`propose` 的入参：状态由知识库钉成 `proposed`）。 */
export type FanoutNoteCard = Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'>

/** 助理扇出的知识条目的 `subject.type`（`subject.id` = 岗位 id，品牌公共是 `brand`）。 */
export const FANOUT_NOTE_SUBJECT = 'assistant_note'

export function fanoutNoteCard(
  item: FanoutItem,
  ctx: {
    workspace_id: WorkspaceId
    owner: PersonId
    at: Iso8601
    batch_id: string
    /** 资料叫什么（文件名，或「对话里的一段话」）。 */
    source_name: string
    /** 资料是什么：会议记录 / 文档 / 聊天里的话。 */
    source_kind: 'meeting' | 'document' | 'human'
    position_name?: string
  },
): FanoutNoteCard {
  const owner_id = item.brand === true ? 'brand' : (item.position_id ?? 'brand')
  return {
    schema_version: 1,
    workspace_id: ctx.workspace_id,
    layer: 'fact',
    domain: 'company',
    scope: [],
    sensitivity: 'internal',
    subject: {
      type: FANOUT_NOTE_SUBJECT,
      id: owner_id,
      key: `fanout:${ctx.batch_id}:${item.id}`,
    },
    statement: item.text,
    structured: {
      batch_id: ctx.batch_id,
      position_id: owner_id,
      ...(ctx.position_name === undefined ? {} : { position_name: ctx.position_name }),
    },
    provenance: [
      {
        source: ctx.source_kind,
        ref: `assistant:${ctx.batch_id}`,
        locator: ctx.source_name,
        quote: item.quote ?? item.text,
        at: ctx.at,
      },
    ],
    confidence: { value: 0.6, state: 'unverified' },
    valid: { from: ctx.at },
    owner: ctx.owner,
    created_by: { kind: 'agent', id: 'assistant' },
  }
}
