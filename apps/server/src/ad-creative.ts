/**
 * WP317（docs/101 §5.1④，决策 559）：**广告素材流水线**的服务端实现（`/v1/ads/creative/*`）。
 *
 * 一个品牌一份（跟着 `BrandModules` 走，存在那个品牌的广告库里）。五件事：
 *
 * 1. **导入导出表**：用户从后台导出的表传上来 → `ads-core` 解析、挑表现差的。
 * 2. **两个子 Agent 写新文案**：标题、描述各一个，各读各的技能（`ad-headlines` /
 *    `ad-descriptions`，公司层改过以公司层为准）；本地按平台条数 / 字数 / 禁用词过一遍。
 *    实验记录里最近几笔带进上下文。
 * 3. **上传表**：WP314 的 `buildAdUploadBundle` 生成（{@link AdCreativeServiceOptions.uploadSheet}）。
 *    新建一律暂停，人自己去后台传；接插件执行在 WP316。
 * 4. **批量出图单**：经设计岗的 `createRequest` 开一张 `request_design`（L3）；
 *    设计岗出变体 L2、入库 L1，那两步都不在这个文件里。
 * 5. **实验记录**：**以这个品牌的投放岗记忆为准**（WP320 起岗位记忆落盘、按品牌分）。
 *    广告库里只留一行索引（什么时候记的、出自哪一轮）；人在记忆面板里改了 / 删了那条，
 *    这里读到的就是改后的 / 没了。没有岗位面（单测、没装岗位的进程）时退回广告库。
 *
 * **这个文件里没有一处碰广告平台**：不读后台、不传表、不改在跑的广告。
 */

import {
  type AdUploadBundleBuilder,
  buildAdUploadBundle,
  type CopyComplete,
  checkExperiment,
  creativeUploadOps,
  creativeUploadSheet,
  decodeExportBytes,
  experimentContext,
  experimentFromMemory,
  experimentMemoryText,
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
  AdsChangesView,
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

/**
 * 投放岗记忆那一侧（docs/54 §3；WP320 起落盘、按品牌分）。实验记录的**真源**。
 * `list` 回 `undefined` = 这个品牌里找不到投放岗位那一层（退回广告库）。
 */
export interface AdCreativeMemoryPort {
  list(actor: AdsActor): { id: string; heading?: string; body: string }[] | undefined
  add(actor: AdsActor, entry: { heading: string; text: string }): Promise<string | undefined>
  update(actor: AdsActor, id: string, entry: { heading: string; text: string }): Promise<void>
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
  requestDesign?: AdCreativeDesignRequester
  /** 设计岗广告那条今天已经出了几张。 */
  designGeneratedToday?: () => number
  memory?: AdCreativeMemoryPort
  /** 上传表生成器：WP314 的 `buildAdUploadBundle`（不给也是它；测试里可以换）。 */
  uploadSheet?: AdUploadBundleBuilder
  /**
   * WP316：「交给插件上传」——把这一轮拼成改动意图，走投放那一张上传表卡（批了插件在用户自己的后台里传）。
   * 不给 = 这台没装插件执行那一半，只能下载表自己去传。
   */
  stageChanges?: (
    actor: AdsActor,
    input: { account_id: string; ops: unknown[]; reason?: string },
  ) => Promise<AdsChangesView>
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
  /**
   * 这个品牌的实验记录：岗位记忆里「广告实验」开头的那几条为准，广告库那一行只补「什么时候记的、
   * 出自哪一轮」。记忆面不在就读广告库。
   */
  const readExperiments = (actor: AdsActor): AdExperimentEntry[] => {
    const memory = options.memory?.list(actor)
    if (memory === undefined) return store.experiments()
    const rows: AdExperimentEntry[] = []
    for (const m of memory) {
      const e = experimentFromMemory(m)
      if (e === undefined) continue
      const meta = store.experiment(e.id)
      rows.push({
        ...e,
        at: meta?.at ?? '',
        ...(meta?.round_id === undefined ? {} : { round_id: meta.round_id }),
        ...(meta?.updated_at === undefined ? {} : { updated_at: meta.updated_at }),
        // WP452：实验设计（样本量 / 护栏）只存在广告库那一行，记忆里只有三格
        ...(meta?.plan === undefined ? {} : { plan: meta.plan }),
      })
    }
    return rows.sort((a, b) => a.round - b.round)
  }
  const experimentOr404 = (actor: AdsActor, id: string): AdExperimentEntry => {
    const found = readExperiments(actor).find((e) => e.id === id)
    if (found === undefined) throw new ApiError('not_found', `没有这笔实验：${id}`)
    return found
  }

  const importView = (imp: AdCreativeImport): AdCreativeImportView => ({
    id: imp.id,
    platform: imp.platform,
    metric: imp.metric,
    rows: imp.rows.length,
    weak: imp.weak,
    notes: imp.notes,
  })

  /** 一轮里收下的文案 → 上传表要的那几条广告（带上导出表里的编号与落地页）。 */
  const adsOfRound = (round: AdCreativeRound) => {
    const imp = store.creativeImport(round.import_id)
    const ads = round.rewrites
      .filter((r) => r.headlines.length > 0 || r.descriptions.length > 0)
      .map((r) => {
        const row = imp?.rows.find((x) => x.ad_id === r.ad_id)
        return {
          campaign: r.campaign,
          ad_group: r.ad_group,
          ...(row?.campaign_id === undefined ? {} : { campaign_id: row.campaign_id }),
          ...(row?.ad_group_id === undefined ? {} : { ad_group_id: row.ad_group_id }),
          ...(row?.final_url === undefined ? {} : { final_url: row.final_url }),
          headlines: r.headlines.map((h) => h.text),
          descriptions: r.descriptions.map((d) => d.text),
        }
      })
    if (ads.length === 0)
      throw new ApiError('invalid_input', '这一轮一条收下的文案都没有，出不了上传表。')
    return ads
  }

  const port: AdCreativePort = {
    importExport: (actor, input) => {
      assertAds(actor)
      const metric = input.metric ?? 'ctr'
      // 字节进来的先用 WP314 的 `decodeExportBytes` 解（UTF-16 的 Excel CSV 也认），再走解析
      const text =
        input.base64 !== undefined
          ? decodeExportBytes(new Uint8Array(Buffer.from(input.base64, 'base64')))
          : (input.text ?? '')
      if (text.trim() === '') throw new ApiError('invalid_input', '这张表是空的。')
      const parsed = parsePerformanceExport(input.platform, text)
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
      const exp = experimentContext(readExperiments(actor), { platform: imp.platform })
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

    sheet: (actor, round_id, input = {}) => {
      assertAds(actor)
      const round = roundOr404(round_id)
      const ads = adsOfRound(round)
      const banned = options.bannedTerms?.()
      const sheet = creativeUploadSheet(
        {
          platform: round.platform,
          ads,
          ...(round.platform === 'meta'
            ? { meta: { page_id: input.meta_page_id, image_hash: input.meta_image_hash } }
            : {}),
          ...(banned === undefined ? {} : { banned_terms: banned }),
        },
        options.uploadSheet ?? buildAdUploadBundle,
      )
      emit(actor, 'ads.creative_sheet', {
        round_id,
        ok: sheet.ok,
        ads: sheet.ads,
        fingerprint: sheet.fingerprint,
      })
      return sheet
    },

    // WP316：这一轮交给插件上传（走投放那一张上传表卡，新建一律暂停）
    stageSheet: async (actor, round_id, input) => {
      assertAds(actor)
      if (options.stageChanges === undefined)
        throw new ApiError(
          'not_implemented',
          '这台机器没装插件执行那一半：下载上传表自己去后台传。',
        )
      const round = roundOr404(round_id)
      const ops = creativeUploadOps({
        platform: round.platform,
        ads: adsOfRound(round),
        ...(round.platform === 'meta'
          ? { meta: { page_id: input.meta_page_id, image_hash: input.meta_image_hash } }
          : {}),
      })
      return options.stageChanges(actor, {
        account_id: input.account_id,
        ops,
        reason: '素材流水线这一轮的新文案（新建广告，先暂停；跑出数再停旧的）。',
      })
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

    experiments: (actor) => {
      assertAds(actor)
      return { rows: readExperiments(actor) }
    },

    addExperiment: async (actor, input) => {
      assertAds(actor)
      const problems = checkExperiment(input)
      if (problems.length > 0) throw new ApiError('invalid_input', problems.join(' '))
      const entry: AdExperimentEntry = {
        id: nextId('adexp'),
        round: nextExperimentRound(readExperiments(actor)),
        hypothesis: input.hypothesis.trim(),
        change: input.change.trim(),
        ...(input.result === undefined || input.result.trim() === ''
          ? {}
          : { result: input.result.trim() }),
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(input.round_id === undefined ? {} : { round_id: input.round_id }),
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        at: clock.now(),
      }
      // 真源是这个品牌的投放岗记忆；记忆面不在才只存广告库（广告库那一行同时是索引）
      const memory = options.memory
      const memory_id =
        memory === undefined || memory.list(actor) === undefined
          ? undefined
          : await memory.add(actor, experimentMemoryText(entry))
      const saved = memory_id === undefined ? entry : { ...entry, id: memory_id, memory_id }
      store.saveExperiment(saved)
      emit(actor, 'ads.experiment_recorded', { experiment_id: saved.id, round: saved.round })
      return saved
    },

    updateExperiment: async (actor, id, input) => {
      assertAds(actor)
      const found = experimentOr404(actor, id)
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
      if (next.memory_id !== undefined && options.memory !== undefined)
        await options.memory.update(actor, next.memory_id, experimentMemoryText(next))
      const saved = next
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
