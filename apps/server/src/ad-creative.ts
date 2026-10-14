/**
 * WP317（docs/101 §5.1④，决策 559）：**广告素材流水线**的服务端实现（`/v1/ads/creative/*`）。
 *
 * 一个品牌一份（跟着 `BrandModules` 走，存在那个品牌的广告库里）。五件事：
 *
 * 1. **导入导出表**：用户从后台导出的表传上来 → `ads-core` 解析、挑表现差的。
 * 2. **两个子 Agent 写新文案**：标题、描述各一个，各读各的技能（`ad-headlines` /
 *    `ad-descriptions`，公司层改过以公司层为准）；本地按平台条数 / 字数 / 禁用词过一遍。
 *    实验记录里最近几笔带进上下文。
 * 3. **上传表**：WP314 合并前用 `ads-core` 的最小版本（{@link AdCreativeServiceOptions.uploadSheet}
 *    是对接口）。新建一律暂停，人自己去后台传；接插件执行在 WP316。
 * 4. **批量出图单**：经设计岗的 `createRequest` 开一张 `request_design`（L3）；
 *    设计岗出变体 L2、入库 L1，那两步都不在这个文件里。
 * 5. **实验记录**：存在本品牌广告库（重启不丢），同步一条进投放岗记忆（docs/54，记忆面板里看得到；
 *    岗位记忆没有落盘层，丢了就在下次列清单时补回去）。
 *
 * **这个文件里没有一处碰广告平台**：不读后台、不传表、不改在跑的广告。
 */

import {
  type AdUploadSheetGenerator,
  type CopyComplete,
  checkExperiment,
  experimentContext,
  experimentMemoryText,
  minimalUploadSheet,
  nextExperimentRound,
  parsePerformanceExport,
  pickWeakAds,
  planDesignBatch,
  rewriteAd,
} from '@agentsws/ads-core'
import type {
  AdCreativeDesignView,
  AdCreativeImportView,
  AdCreativePort,
  AdsActor,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  AdCopyField,
  AdCreativeImport,
  AdCreativeRewrite,
  AdCreativeRound,
  AdExperimentEntry,
  AdPerformanceRow,
  Clock,
  EventEnvelope,
  WorkspaceId,
} from '@agentsws/contracts'
import { adsPlatformOfRole } from '@agentsws/contracts'
import type { AdsStore } from './ads.js'

/** 一轮最多写几条广告（每条要两到四次模型调用）。 */
export const AD_CREATIVE_MAX_ADS_PER_ROUND = 20

/** 设计岗那一下（`designService.port.createRequest` 包一层）。 */
export type AdCreativeDesignRequester = (
  actor: AdsActor,
  input: { title: string; need: string; spec_ids: string[]; variants: number },
) => Promise<{ request_id: string; staged: { staged: boolean; level?: string; message?: string } }>

/** 投放岗记忆那一侧（docs/54 §3）。不给就不同步（单测与没装岗位面的进程）。 */
export interface AdCreativeMemoryPort {
  add(actor: AdsActor, entry: { heading: string; text: string }): Promise<string | undefined>
  update(id: string, entry: { heading: string; text: string }): Promise<boolean>
  exists(id: string): boolean
}

export interface AdCreativeServiceOptions {
  workspace_id: WorkspaceId
  clock: Clock
  random(): number
  store: AdsStore
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 子 Agent 的模型。回 `undefined` = 这台没接能写文案的模型（替身档），照实说、不编。 */
  complete?: (actor: AdsActor) => CopyComplete | undefined
  /** 子 Agent 的技能正文（叠过公司层的那一份）。不给就只有硬规矩。 */
  skillText?: (actor: AdsActor, name: string) => Promise<string | undefined>
  /** 品牌语气（品牌档案的口吻 + 话术技能）。 */
  brandVoice?: (actor: AdsActor) => Promise<string | undefined>
  /** 这条广告相关的事实卡摘录。 */
  facts?: (actor: AdsActor, ad: AdPerformanceRow) => Promise<string | undefined>
  /** 品牌 DESIGN.md 给文案的那一段（`adDesignPrompt`）。 */
  designPrompt?: () => string | undefined
  /** 品牌禁用词。 */
  bannedTerms?: () => readonly string[]
  brandName?: () => string
  requestDesign?: AdCreativeDesignRequester
  /** 设计岗广告那条今天已经出了几张。 */
  designGeneratedToday?: () => number
  memory?: AdCreativeMemoryPort
  /** 上传表生成器（WP314 对接口）。不给就用 `ads-core` 的最小版本。 */
  uploadSheet?: AdUploadSheetGenerator
}

export interface AdCreativeServiceAssembly {
  port: AdCreativePort
}

const SKILL_OF: Readonly<Record<AdCopyField, string>> = {
  headline: 'ad-headlines',
  description: 'ad-descriptions',
}

export function createAdCreativeService(
  options: AdCreativeServiceOptions,
): AdCreativeServiceAssembly {
  const { workspace_id, clock, store } = options
  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  /** 只对投放那四条职责开（同 `ads-service` 的 `platformOf`）。 */
  const assertAds = (actor: AdsActor): void => {
    if (adsPlatformOfRole(actor.role_id) === undefined)
      throw new ApiError(
        'forbidden',
        `${actor.role_id} 不是一条投放职责——素材流水线只对 ads.* 开。`,
      )
  }

  const emit = (actor: AdsActor, type: string, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor.person_id },
      correlation: { trace_id: `tr_adcreative_${Date.parse(clock.now()).toString(36)}` },
      payload: { role_id: actor.role_id, ...payload },
    })
  }

  const importOr404 = (id: string): AdCreativeImport => {
    const found = store.creativeImport(id)
    if (found === undefined) throw new ApiError('not_found', `没有这次导入：${id}`)
    return found
  }
  const roundOr404 = (id: string): AdCreativeRound => {
    const found = store.creativeRound(id)
    if (found === undefined) throw new ApiError('not_found', `没有这一轮：${id}`)
    return found
  }
  const experimentOr404 = (id: string): AdExperimentEntry => {
    const found = store.experiment(id)
    if (found === undefined) throw new ApiError('not_found', `没有这笔实验：${id}`)
    return found
  }

  /** 同步一笔进投放岗记忆；记忆面那边不在就跳过（不因为它失败而丢这笔）。 */
  const mirror = async (actor: AdsActor, entry: AdExperimentEntry): Promise<string | undefined> => {
    if (options.memory === undefined) return entry.memory_id
    const text = experimentMemoryText(entry, options.brandName?.() ?? '这个品牌')
    try {
      if (entry.memory_id !== undefined && options.memory.exists(entry.memory_id)) {
        await options.memory.update(entry.memory_id, text)
        return entry.memory_id
      }
      return (await options.memory.add(actor, text)) ?? entry.memory_id
    } catch {
      return entry.memory_id
    }
  }

  const importView = (imp: AdCreativeImport): AdCreativeImportView => ({
    id: imp.id,
    platform: imp.platform,
    metric: imp.metric,
    rows: imp.rows.length,
    weak: imp.weak,
    notes: imp.notes,
  })

  const port: AdCreativePort = {
    importExport: (actor, input) => {
      assertAds(actor)
      const metric = input.metric ?? 'ctr'
      const parsed = parsePerformanceExport(input.platform, input.text)
      const weak = pickWeakAds(parsed.rows, metric)
      const notes = [...parsed.notes]
      if (parsed.rows.length > 0 && weak.every((w) => w.verdict === 'thin'))
        notes.push('没有够样本又明显差的广告：可以等数据多一点，或者手动挑几条来写。')
      const imp: AdCreativeImport = {
        id: nextId('adimp'),
        platform: input.platform,
        metric,
        rows: parsed.rows,
        weak,
        notes,
        created_at: clock.now(),
      }
      store.saveCreativeImport(imp)
      emit(actor, 'ads.creative_imported', {
        import_id: imp.id,
        platform: imp.platform,
        rows: imp.rows.length,
        weak: weak.filter((w) => w.verdict === 'weak').length,
      })
      return importView(imp)
    },

    rewrite: async (actor, input) => {
      assertAds(actor)
      const imp = importOr404(input.import_id)
      const wanted =
        input.ad_ids === undefined
          ? imp.weak.filter((w) => w.verdict === 'weak').map((w) => w.ad_id)
          : input.ad_ids
      const targets = imp.rows.filter((r) => wanted.includes(r.ad_id))
      if (targets.length === 0)
        throw new ApiError(
          'invalid_input',
          input.ad_ids === undefined
            ? '这张表里没有够样本又明显差的广告。手动挑几条（ad_ids）再来。'
            : '挑的这几条在这张表里找不到。',
        )
      const notes: string[] = []
      const picked = targets.slice(0, AD_CREATIVE_MAX_ADS_PER_ROUND)
      if (targets.length > picked.length)
        notes.push(
          `一轮最多写 ${AD_CREATIVE_MAX_ADS_PER_ROUND} 条广告，先写最差的 ${picked.length} 条，剩下的下一轮。`,
        )
      const complete = options.complete?.(actor)
      const exp = experimentContext(store.experiments(), { platform: imp.platform })
      const skills: Partial<Record<AdCopyField, string>> = {}
      for (const field of ['headline', 'description'] as const) {
        const text = await options.skillText?.(actor, SKILL_OF[field])
        if (text !== undefined && text.trim() !== '') skills[field] = text
      }
      const voice = await options.brandVoice?.(actor)
      const design = options.designPrompt?.()
      const banned = options.bannedTerms?.()
      const rewrites: AdCreativeRewrite[] = []
      if (complete === undefined)
        notes.push('这台还没接上能写文案的模型（现在是替身），去「模型」里接一个再来。')
      for (const ad of picked) {
        if (complete === undefined) {
          rewrites.push({
            ad_id: ad.ad_id,
            campaign: ad.campaign,
            ad_group: ad.ad_group,
            headlines: [],
            descriptions: [],
            rejected: [],
            notes: [],
          })
          continue
        }
        const facts = await options.facts?.(actor, ad)
        const weak = imp.weak.find((w) => w.ad_id === ad.ad_id)
        rewrites.push(
          await rewriteAd(
            {
              platform: imp.platform,
              ad,
              skills,
              ...(weak === undefined ? {} : { weak }),
              ...(voice === undefined ? {} : { brand_voice: voice }),
              ...(facts === undefined ? {} : { facts }),
              ...(design === undefined || design === '' ? {} : { design_prompt: design }),
              ...(exp === undefined ? {} : { experiments: exp.text }),
              ...(banned === undefined ? {} : { banned_terms: banned }),
            },
            complete,
          ),
        )
      }
      const round: AdCreativeRound = {
        id: nextId('adround'),
        platform: imp.platform,
        import_id: imp.id,
        rewrites,
        experiments_used: exp?.used ?? 0,
        notes,
        created_at: clock.now(),
      }
      store.saveCreativeRound(round)
      emit(actor, 'ads.creative_round', {
        round_id: round.id,
        platform: round.platform,
        ads: rewrites.length,
        headlines: rewrites.reduce((n, r) => n + r.headlines.length, 0),
        descriptions: rewrites.reduce((n, r) => n + r.descriptions.length, 0),
        rejected: rewrites.reduce((n, r) => n + r.rejected.length, 0),
        experiments_used: round.experiments_used,
      })
      return round
    },

    round: (actor, id) => {
      assertAds(actor)
      return roundOr404(id)
    },

    sheet: (actor, round_id) => {
      assertAds(actor)
      const round = roundOr404(round_id)
      const imp = store.creativeImport(round.import_id)
      const ads = round.rewrites
        .filter((r) => r.headlines.length > 0 || r.descriptions.length > 0)
        .map((r) => {
          const row = imp?.rows.find((x) => x.ad_id === r.ad_id)
          return {
            campaign: r.campaign,
            ad_group: r.ad_group,
            ...(row?.final_url === undefined ? {} : { final_url: row.final_url }),
            headlines: r.headlines.map((h) => h.text),
            descriptions: r.descriptions.map((d) => d.text),
          }
        })
      if (ads.length === 0)
        throw new ApiError('invalid_input', '这一轮一条收下的文案都没有，出不了上传表。')
      const generate = options.uploadSheet ?? minimalUploadSheet
      const sheet = generate({ platform: round.platform, ads, date: clock.now().slice(0, 10) })
      emit(actor, 'ads.creative_sheet', { round_id, format: sheet.format, rows: sheet.rows })
      return sheet
    },

    requestDesign: async (actor, round_id, input) => {
      assertAds(actor)
      const round = roundOr404(round_id)
      const plan = planDesignBatch({
        platform: round.platform,
        rewrites: round.rewrites,
        ...(input.variants === undefined ? {} : { variants: input.variants }),
        ...(input.spec_ids === undefined ? {} : { spec_ids: input.spec_ids }),
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        generated_today: options.designGeneratedToday?.() ?? 0,
      })
      const view: AdCreativeDesignView = {
        requested: false,
        title: plan.title,
        variants: plan.variants,
        spec_ids: plan.spec_ids,
        notes: plan.notes,
      }
      if (plan.copy.length === 0) return view
      if (options.requestDesign === undefined)
        throw new ApiError('not_implemented', '这个服务进程没有装设计岗，下不了出图单。')
      const out = await options.requestDesign(actor, {
        title: plan.title,
        need: plan.need,
        spec_ids: plan.spec_ids,
        variants: plan.variants,
      })
      emit(actor, 'ads.creative_design_requested', {
        round_id,
        request_id: out.request_id,
        variants: plan.variants,
      })
      return { ...view, requested: true, request_id: out.request_id, staged: out.staged }
    },

    experiments: async (actor) => {
      assertAds(actor)
      const rows = store.experiments()
      // 岗位记忆没有落盘层：重启后那一条没了就补回去（这里是唯一的真源）
      if (options.memory !== undefined)
        for (const row of rows) {
          if (row.memory_id !== undefined && options.memory.exists(row.memory_id)) continue
          const memory_id = await mirror(actor, row)
          if (memory_id !== undefined && memory_id !== row.memory_id)
            store.saveExperiment({ ...row, memory_id })
        }
      return { rows: store.experiments() }
    },

    addExperiment: async (actor, input) => {
      assertAds(actor)
      const problems = checkExperiment(input)
      if (problems.length > 0) throw new ApiError('invalid_input', problems.join(' '))
      const entry: AdExperimentEntry = {
        id: nextId('adexp'),
        round: nextExperimentRound(store.experiments()),
        hypothesis: input.hypothesis.trim(),
        change: input.change.trim(),
        ...(input.result === undefined || input.result.trim() === ''
          ? {}
          : { result: input.result.trim() }),
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(input.round_id === undefined ? {} : { round_id: input.round_id }),
        at: clock.now(),
      }
      const memory_id = await mirror(actor, entry)
      const saved = memory_id === undefined ? entry : { ...entry, memory_id }
      store.saveExperiment(saved)
      emit(actor, 'ads.experiment_recorded', { experiment_id: saved.id, round: saved.round })
      return saved
    },

    updateExperiment: async (actor, id, input) => {
      assertAds(actor)
      const found = experimentOr404(id)
      const next: AdExperimentEntry = {
        ...found,
        ...(input.hypothesis === undefined ? {} : { hypothesis: input.hypothesis.trim() }),
        ...(input.change === undefined ? {} : { change: input.change.trim() }),
        ...(input.result === undefined ? {} : { result: input.result.trim() }),
        updated_at: clock.now(),
      }
      const problems = checkExperiment({
        hypothesis: next.hypothesis,
        change: next.change,
        ...(next.result === undefined ? {} : { result: next.result }),
      })
      if (problems.length > 0) throw new ApiError('invalid_input', problems.join(' '))
      const memory_id = await mirror(actor, next)
      const saved = memory_id === undefined ? next : { ...next, memory_id }
      store.saveExperiment(saved)
      emit(actor, 'ads.experiment_updated', {
        experiment_id: id,
        has_result: (saved.result ?? '') !== '',
      })
      return saved
    },
  }
  return { port }
}
