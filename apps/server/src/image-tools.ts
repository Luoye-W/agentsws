/**
 * WP268（决策 213）：**生图 / 改图 / 素材库**三个工具的执行器，以及挑图卡 / 超额卡被决定之后的那一跳。
 *
 * 一次 `generate_image` / `edit_image`：
 * 1. 判职责（设计岗五条 + 网页模板）、判生图那一档配没配、会不会改图；
 * 2. 整理参数：宽高比 / 规格 → 这个模型认的画布；参考图从品牌素材库取（店里商品图先取进素材库）；
 *    提示词过一道品牌禁忌词自查（命中就让模型重写，不花钱）；
 * 3. **花积分前先算**：官方接口 = 张数 × 单价（价目表 `ai.image` / `ai.image_edit`），自己的接口不扣；
 *    这一次运行累计超了 `IMAGE_CAPS`、或今天出图到了 `DESIGN_CAPS.max_generations_per_day` → 不出图，出一张超额卡问人；
 * 4. 出图 → 每张进品牌素材库（来源、提示词、模型、积分）→ 事项里出一张挑图卡（选一张 / 都不要 / 再来一版）。
 *
 * 卡被决定（`onDecided`）：选中 → 素材记「选中」（谁点的由服务端按决定人盖）；带 `place` 的再交给
 * {@link ImageServiceOptions.place}（传店铺文件 → 写进模板那一格 → 推未发布预览）；「再来一版」照原参数再出一批
 * （同样先判上限）；「都不要」→ 这一批记「不要」；超额卡批了 → 照卡上那一份出图。
 *
 * 图片字节不进事件日志、不进卡；事件里只有张数、积分、模型名。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  BrandDesignContext,
  Clock,
  DesignAsset,
  GeneratedImage,
  ImageAspectRatio,
  ImageBudgetPayload,
  ImageInput,
  ImageJob,
  ImagePickPayload,
  ImagePickVariant,
  ImagePlaceTarget,
  ImageProvider,
  Recipient,
  RunRequest,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  DESIGN_CAPS,
  designDutyOfRole,
  IMAGE_ASPECT_RATIOS,
  IMAGE_CAPS,
  IMAGE_EDIT_MAX_REFERENCES,
  IMAGE_PICK_AGAIN,
  IMAGE_PICK_PREFIX,
  imageCredits,
} from '@agentsws/contracts'
import { checkPrompt, resolveSpec } from '@agentsws/design-core'
import { imageSizeFor } from '@agentsws/model-gateway'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import {
  EDIT_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
  IMAGE_TOOL_NAMES,
  isImageRole,
  LIST_BRAND_ASSETS_TOOL,
} from '@agentsws/stand-ins'
import { cardRefOf, type Work } from '@agentsws/work'
import { BrandAssetError, type BrandAssets } from './brand-assets.js'
import type { ShopifyAdminReader } from './shop-admin.js'
import { productImageUrls } from './shop-files.js'

/** 生图那一档现在的样子（`models.image()` 那一份的几格）。 */
export interface ImagePricing {
  official: boolean
  model?: string
  /** 官方接口一张多少积分（`ai.image`）。 */
  per_image?: number
  /** 改图一张多少积分（`ai.image_edit`；没有这一行按 `per_image`）。 */
  per_edit?: number
}

/** 挑中之后挂到主题的结果（`image-place.ts`）。 */
export interface PlaceOutcome {
  ok: boolean
  /** 一句人话（进事项时间线）。 */
  message: string
}

export interface ImageServiceOptions {
  workspace_id: WorkspaceId
  clock: Clock
  assets: BrandAssets
  /** 生图那一档（取值函数：设置页改了立刻生效）。 */
  images(): ImageProvider | undefined
  pricing(): ImagePricing
  approvals(): ApprovalBus | undefined
  work(): Pick<Work, 'onCard' | 'appendEvent'> | undefined
  /** 这个品牌的 `DESIGN.md` 那一段（有就接在提示词后面）。 */
  designContext?(): BrandDesignContext | undefined
  /** 品牌禁忌词（品牌系统里写的那几条）。 */
  forbidden?(): readonly string[]
  /** 店里商品图那一路（只读）；没授权 / 不是 Shopify = undefined。 */
  shopReader?(): Promise<Pick<ShopifyAdminReader, 'query'> | undefined>
  /** 挑中且带 `place`：传店铺文件 → 写模板 → 推未发布预览。不给 = 只记选中。 */
  place?(input: {
    asset: DesignAsset
    target: ImagePlaceTarget
    matter_id?: string
    by?: string
  }): Promise<PlaceOutcome>
  /** 只回网址的上游、店里商品图：取字节用（不给用全局 fetch）。 */
  fetch?: (
    url: string,
  ) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>
  appendEvent?(type: string, payload: Record<string, unknown>): void
}

export interface ImageService {
  executeTool: ToolExecutor
  /** 这条职责这一次运行摆哪几个（生图没配 = 空；模型不会改图 = 不摆 `edit_image`）。 */
  offered(role_id: string): Promise<string[]>
  /** 挑图卡 / 超额卡被决定之后（`server.ts` 的决定钩子调）。别的卡回 false。 */
  onDecided(item: ApprovalItem): Promise<boolean>
}

/** 一次运行里出图的上下文（批了超额卡 / 再来一版时从卡上还原）。 */
interface JobCtx {
  run_id: string
  role_id: string
  assignment_id: string
  person_id: string
  matter_id?: string
}

const str = (v: unknown, max = 4000): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined

const PLACE_FILE = /^(templates|sections)\/[\w.-]+\.json$|^config\/settings_data\.json$/
const KEY = /^[\w-]{1,80}$/
const BLOCK_PATH = /^[\w-]{1,80}(\/[\w-]{1,80}){0,3}$/

/** 宽高比 → 最接近的那一档（规格表里的画布换算用）。 */
function nearestAspect(width: number, height: number): ImageAspectRatio {
  const r = width / height
  let best: ImageAspectRatio = '1:1'
  let gap = Number.POSITIVE_INFINITY
  for (const a of IMAGE_ASPECT_RATIOS) {
    const [w, h] = a.split(':').map(Number) as [number, number]
    const d = Math.abs(Math.log(w / h) - Math.log(r))
    if (d < gap) {
      gap = d
      best = a
    }
  }
  return best
}

export class ImageToolError extends Error {
  constructor(
    readonly status: 'error' | 'blocked',
    message: string,
  ) {
    super(message)
    this.name = 'ImageToolError'
  }
}

/** 挂到哪一格给人看的那几个字。 */
export function placeLabel(t: ImagePlaceTarget): string {
  const page = /^templates\/index\.json$/.test(t.file)
    ? '首页'
    : t.file.startsWith('templates/')
      ? `「${t.file.replace(/^templates\/|\.json$/g, '')}」页`
      : t.file.startsWith('config/')
        ? '主题设置'
        : `「${t.file.replace(/^sections\/|\.json$/g, '')}」`
  const where = [t.section, t.block].filter((x) => x !== undefined).join(' / ')
  return where === '' ? page : `${page}「${where}」`
}

export function createImageService(options: ImageServiceOptions): ImageService {
  const { workspace_id, clock, assets } = options
  /** 这一次运行累计出了几张、花了多少（「再来一版」也算进去）。留最近 200 次。 */
  const usage = new Map<string, { images: number; credits: number }>()
  const usageOf = (run_id: string): { images: number; credits: number } =>
    usage.get(run_id) ?? { images: 0, credits: 0 }
  const addUsage = (run_id: string, images: number, credits: number): void => {
    const u = usageOf(run_id)
    usage.delete(run_id)
    usage.set(run_id, {
      images: u.images + images,
      credits: Math.round((u.credits + credits) * 100) / 100,
    })
    while (usage.size > 200) usage.delete(usage.keys().next().value as string)
  }
  const emit = (type: string, payload: Record<string, unknown>): void =>
    options.appendEvent?.(type, { workspace_id, ...payload })
  const fetchBytes =
    options.fetch ??
    ((url: string) =>
      fetch(url) as unknown as ReturnType<NonNullable<ImageServiceOptions['fetch']>>)

  const note = (matter_id: string | undefined, text: string): void => {
    if (matter_id === undefined) return
    try {
      options.work()?.appendEvent(matter_id as never, {
        kind: 'status',
        text,
        actor: { kind: 'system', id: 'images' },
      })
    } catch {
      // 事项没了：照样往下走
    }
  }

  const providerOr = (operation: 'generate' | 'edit'): ImageProvider => {
    const p = options.images()
    if (p === undefined || !p.available)
      throw new ImageToolError(
        'error',
        p?.unavailable_reason ?? '生图还没配：去设置 → 模型 →「生图」那一块选一个。',
      )
    if (operation === 'edit' && p.edit === undefined)
      throw new ImageToolError(
        'error',
        `现在配的生图模型（${p.ref.model}）不会拿参考图改图。用 generate_image 从零出，或在设置里换一个会改图的模型。`,
      )
    return p
  }

  /** 这一批要花多少（官方接口；自己的接口 = 0）。 */
  const costOf = (
    job: Pick<ImageJob, 'operation' | 'n'>,
  ): { per: number; total: number; own_key: boolean } => {
    const p = options.pricing()
    if (!p.official) return { per: 0, total: 0, own_key: true }
    const per = (job.operation === 'edit' ? (p.per_edit ?? p.per_image) : p.per_image) ?? 0
    return { per, total: imageCredits(job.n, per), own_key: false }
  }

  const today = (): number => {
    const day = clock.now().slice(0, 10)
    return assets
      .list({ source: 'generated', limit: 10_000 })
      .filter((a) => a.created_at.slice(0, 10) === day).length
  }

  /** 工具参数 → 一份 `ImageJob`（参考图在这一步取进素材库）。 */
  const jobOf = async (
    operation: 'generate' | 'edit',
    input: Record<string, unknown>,
    request: RunRequest,
  ): Promise<ImageJob> => {
    const prompt = str(input.prompt)
    if (prompt === undefined) throw new ImageToolError('error', '要给 prompt（画面描述）。')
    const provider = providerOr(operation)
    const spec_id = str(input.spec_id, 100)
    const spec = spec_id === undefined ? undefined : resolveSpec(spec_id)
    const aspect: ImageAspectRatio | undefined =
      spec !== undefined
        ? nearestAspect(spec.width, spec.height)
        : IMAGE_ASPECT_RATIOS.find((a) => a === input.aspect_ratio)
    const n = Math.max(1, Math.min(IMAGE_CAPS.per_call, Math.floor(Number(input.n ?? 2)) || 2))
    const tags = Array.isArray(input.tags)
      ? input.tags
          .map((t) => str(t, 40))
          .filter((t): t is string => t !== undefined)
          .slice(0, 5)
      : []
    const style_note = str(input.style_note, 600)
    // 品牌禁忌词：命中就让模型重写（不花钱）——与设计岗出图同一张表
    const check = checkPrompt(`${prompt}\n${style_note ?? ''}`, options.forbidden?.() ?? [])
    if (!check.ok) throw new ImageToolError('blocked', check.rewrite_instruction)
    let place: ImagePlaceTarget | undefined
    const rawPlace = input.place
    if (rawPlace !== undefined && rawPlace !== null && typeof rawPlace === 'object') {
      const p = rawPlace as Record<string, unknown>
      const file = str(p.file, 200)
      const setting = str(p.setting, 80)
      const section = str(p.section, 80)
      const block = str(p.block, 330)
      if (!['site.shopify-theme', 'site.builder'].includes(request.actor.role_id))
        throw new ImageToolError(
          'blocked',
          'place 只给网页模板用（挂到主题某一格）；别的职责出的图进素材库就好。',
        )
      if (
        file === undefined ||
        !PLACE_FILE.test(file) ||
        setting === undefined ||
        !KEY.test(setting)
      )
        throw new ImageToolError(
          'error',
          'place 写得不对：file 要是 templates/*.json、sections/*.json 或 config/settings_data.json，setting 是图片设置名。',
        )
      if (!file.startsWith('config/') && section === undefined)
        throw new ImageToolError(
          'error',
          'place 要给 section（模板 JSON 里 sections 下的那个键）。',
        )
      if (
        (section !== undefined && !KEY.test(section)) ||
        (block !== undefined && !BLOCK_PATH.test(block))
      )
        throw new ImageToolError(
          'error',
          'place 的 section / block 只能是字母、数字、- 和 _（嵌套块用 / 连）。',
        )
      place = {
        file,
        setting,
        ...(section === undefined ? {} : { section }),
        ...(block === undefined ? {} : { block }),
      }
    }
    const refs: string[] = []
    let mask_asset_id: string | undefined
    if (operation === 'edit') {
      const ids = Array.isArray(input.asset_ids)
        ? input.asset_ids.map((x) => str(x, 100)).filter((x): x is string => x !== undefined)
        : []
      for (const id of ids) {
        const a = assets.get(id)
        if (a === undefined || a.status === 'rejected')
          throw new ImageToolError(
            'error',
            `素材库里没有这张图（${id}），先用 list_brand_assets 查一下。`,
          )
        refs.push(a.id)
      }
      const product_id = str(input.product_id, 200)
      if (product_id !== undefined) {
        const reader = await options.shopReader?.()
        if (reader === undefined)
          throw new ImageToolError(
            'error',
            '拿不到店里的商品图：店铺还没授权（或不是 Shopify 店）。可以让人把产品图拖进事项，再用 asset_ids。',
          )
        const found = await productImageUrls(reader, product_id, 2)
        if (found.urls.length === 0)
          throw new ImageToolError(
            'error',
            `这件商品${found.title === undefined ? '' : `「${found.title}」`}没有图。`,
          )
        for (const url of found.urls) {
          const a = await assets.importFromUrl({
            url,
            origin: { kind: 'shop_product', ref: product_id },
            ...(request.work_item?.id === undefined ? {} : { matter_id: request.work_item.id }),
            fetch: fetchBytes,
          })
          if (!refs.includes(a.id)) refs.push(a.id)
        }
      }
      if (refs.length === 0)
        throw new ImageToolError(
          'error',
          '改图要参考图：给 asset_ids（素材库里的图）或 product_id（店里的商品）。',
        )
      const max = provider.max_reference_images ?? IMAGE_EDIT_MAX_REFERENCES
      refs.splice(max)
      const mask = str(input.mask_asset_id, 100)
      if (mask !== undefined) {
        if (assets.get(mask) === undefined)
          throw new ImageToolError('error', `素材库里没有这张遮罩图（${mask}）。`)
        mask_asset_id = mask
      }
    }
    return {
      operation,
      prompt,
      size:
        spec !== undefined && !/^gpt-image|^dall-e/i.test(provider.ref.model)
          ? `${spec.width}x${spec.height}`
          : imageSizeFor(aspect, provider.ref.model),
      ...(aspect === undefined ? {} : { aspect_ratio: aspect }),
      ...(spec_id === undefined ? {} : { spec_id }),
      n,
      ...(refs.length === 0 ? {} : { reference_asset_ids: refs }),
      ...(mask_asset_id === undefined ? {} : { mask_asset_id }),
      ...(style_note === undefined ? {} : { style_note }),
      ...(tags.length === 0 ? {} : { tags }),
      ...(place === undefined ? {} : { place }),
    }
  }

  const recipients = (ctx: JobCtx): Recipient[] => [
    { person: ctx.person_id as never, via: 'role_holder' },
  ]

  /** 出一张卡并挂到事项上。 */
  const card = async <P>(input: {
    ctx: JobCtx
    kind: 'image_pick' | 'image_budget'
    title: string
    summary: string
    payload: P
    options?: { id: string; label: string }[]
    seen: string[]
  }): Promise<ApprovalItem> => {
    const bus = options.approvals()
    if (bus === undefined) throw new ImageToolError('error', '这个进程没接审批，出不了挑图卡。')
    const { ctx } = input
    const item = await bus.create({
      workspace_id,
      schema_version: 1,
      kind: input.kind,
      role_id: ctx.role_id,
      subject: {
        object: { type: 'design_asset', id: input.seen[0] ?? ctx.run_id },
        ...(ctx.matter_id === undefined ? {} : { matter_id: ctx.matter_id as never }),
      },
      dedupe_key: `${input.kind}@${ctx.run_id}/${input.seen[0] ?? clock.now()}:${workspace_id}`,
      title: input.title,
      summary: input.summary,
      payload: input.payload,
      ...(input.options === undefined ? {} : { options: input.options }),
      evidence: {
        run_id: ctx.run_id as never,
        source_events: [],
        provenance: { seen: input.seen.map((id) => ({ type: 'design_asset', id })) },
        precheck: {},
      },
      proposer: {
        kind: 'agent',
        id: `agent_${ctx.role_id}`,
        assignment_id: ctx.assignment_id as never,
      },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: recipients(ctx),
        rule: 'role_holder',
        escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      risk_class: input.kind === 'image_pick' ? 'medium' : 'low',
    } as never)
    try {
      options.work()?.onCard(cardRefOf(item))
    } catch {
      // 事项挂不上不影响卡本身（卡在待办 / 卡片页照样看得见）
    }
    return item
  }

  /** 取参考图 / 遮罩的字节。 */
  const inputOf = async (id: string): Promise<ImageInput> => {
    const b = await assets.bytes(id)
    if (b === undefined)
      throw new ImageToolError('error', `素材库里这张图的原图读不到了（${id}）。`)
    return { bytes: b.bytes, content_type: b.content_type, filename: b.filename }
  }

  /** 只回网址的上游：取字节（只认 https）。取不到的这一张跳过。 */
  const bytesOf = async (img: GeneratedImage): Promise<Uint8Array | undefined> => {
    if (img.bytes !== undefined) return img.bytes
    if (img.url === undefined || !img.url.startsWith('https://')) return undefined
    try {
      const res = await fetchBytes(img.url)
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined
    } catch {
      return undefined
    }
  }

  /** 真出图 → 进素材库 → 挑图卡。 */
  const runJob = async (
    job: ImageJob,
    ctx: JobCtx,
  ): Promise<{ item: ApprovalItem; assets: DesignAsset[]; credits: number; own_key: boolean }> => {
    const provider = providerOr(job.operation)
    const design = options.designContext?.()
    const prompt = [
      job.prompt,
      ...(job.style_note === undefined ? [] : [`风格：${job.style_note}`]),
      ...(design?.present === true ? [design.prompt] : []),
    ].join('\n\n')
    const meta = {
      workspace_id,
      assignment_id: ctx.assignment_id,
      role_id: ctx.role_id,
      run_id: ctx.run_id,
      purpose: 'run',
    } as never
    const out =
      job.operation === 'edit'
        ? await (provider.edit as NonNullable<ImageProvider['edit']>)({
            prompt,
            images: await Promise.all((job.reference_asset_ids ?? []).map(inputOf)),
            ...(job.mask_asset_id === undefined ? {} : { mask: await inputOf(job.mask_asset_id) }),
            size: job.size,
            n: job.n,
            fidelity: 'high',
            meta,
          })
        : await provider.generate({ prompt, size: job.size, n: job.n, meta })
    const cost = costOf({ operation: job.operation, n: out.assets.length })
    const duty = designDutyOfRole(ctx.role_id)?.id ?? 'dtc'
    const saved: DesignAsset[] = []
    for (const img of out.assets) {
      const bytes = await bytesOf(img)
      if (bytes === undefined) continue
      saved.push(
        await assets.save({
          bytes,
          content_type: img.content_type,
          width: img.width,
          height: img.height,
          duty,
          spec_id: job.spec_id ?? `aspect:${job.aspect_ratio ?? '1:1'}`,
          status: 'variant',
          ...(job.tags === undefined ? {} : { tags: job.tags }),
          provenance: {
            source: 'generated',
            operation: job.operation,
            model: out.model,
            prompt_sha256: img.prompt_sha256,
            prompt: job.prompt.slice(0, 2000),
            ...(job.reference_asset_ids === undefined
              ? {}
              : { reference_asset_ids: job.reference_asset_ids }),
            ...(cost.own_key ? {} : { credits: cost.per }),
            run_id: ctx.run_id,
            role_id: ctx.role_id,
            ...(ctx.matter_id === undefined ? {} : { matter_id: ctx.matter_id }),
            generated_at: clock.now(),
          },
        }),
      )
    }
    if (saved.length === 0)
      throw new ImageToolError('error', '模型回了结果，但一张图都没取下来，这次不算数。')
    const credits = imageCredits(saved.length, cost.per)
    addUsage(ctx.run_id, saved.length, credits)
    emit('image.generated', {
      run_id: ctx.run_id,
      operation: job.operation,
      images: saved.length,
      credits,
      model: out.model.model,
    })
    const variants: ImagePickVariant[] = saved.map((a, i) => ({
      id: `${IMAGE_PICK_PREFIX}${a.id}`,
      asset_id: a.id,
      url: `/v1/brand-assets/${a.id}/file`,
      label: `第 ${i + 1} 张`,
      ...(a.width === undefined ? {} : { width: a.width }),
      ...(a.height === undefined ? {} : { height: a.height }),
    }))
    const again = costOf({ operation: job.operation, n: job.n })
    const payload: ImagePickPayload = {
      form: 'image_pick',
      variants,
      job,
      model_label: out.model.model,
      credits,
      ...(cost.own_key ? { own_key: true } : {}),
      again_credits: again.total,
      upload: job.place !== undefined,
      run_id: ctx.run_id,
      ...(ctx.matter_id === undefined ? {} : { matter_id: ctx.matter_id }),
    }
    const where = job.place === undefined ? undefined : placeLabel(job.place)
    const item = await card({
      ctx,
      kind: 'image_pick',
      title: where === undefined ? `挑一张图（${saved.length} 张）` : `挑一张图：挂到${where}`,
      summary: [
        cost.own_key
          ? `出了 ${saved.length} 张（${out.model.model}，用你自己的接口，不扣积分）。`
          : `出了 ${saved.length} 张（${out.model.model}，花了 ${credits} 积分）。`,
        ...(where === undefined
          ? ['选中的进素材库当定稿用。']
          : [`选中的那张会传到店铺「文件」、写进${where}，再推一份新的未发布预览（线上不动）。`]),
        again.own_key
          ? '都不行点「都不要」；想换一批点「再来一版」。'
          : `都不行点「都不要」；想换一批点「再来一版」（约 ${again.total} 积分）。`,
      ].join('\n'),
      payload,
      options: [
        ...variants.map((v) => ({ id: v.id, label: v.label })),
        { id: IMAGE_PICK_AGAIN, label: '再来一版' },
      ],
      seen: saved.map((a) => a.id),
    })
    return { item, assets: saved, credits, own_key: cost.own_key }
  }

  /** 先判上限：超了出超额卡；没超就出图。 */
  const generateOrAsk = async (job: ImageJob, ctx: JobCtx): Promise<ToolExecution> => {
    const cost = costOf(job)
    const used = usageOf(ctx.run_id)
    const reason: ImageBudgetPayload['reason'] | undefined =
      used.images + job.n > IMAGE_CAPS.per_run_images
        ? 'per_run_images'
        : !cost.own_key && used.credits + cost.total > IMAGE_CAPS.per_run_credits
          ? 'per_run_credits'
          : today() + job.n > DESIGN_CAPS.max_generations_per_day
            ? 'per_day'
            : undefined
    const model = options.images()?.ref.model ?? ''
    if (reason !== undefined) {
      const payload: ImageBudgetPayload = {
        form: 'image_budget',
        job,
        model_label: model,
        credits: cost.total,
        ...(cost.own_key ? { own_key: true } : {}),
        reason,
        used,
        run_id: ctx.run_id,
        ...(ctx.matter_id === undefined ? {} : { matter_id: ctx.matter_id }),
        role_id: ctx.role_id,
        assignment_id: ctx.assignment_id,
        at: clock.now(),
      }
      const why =
        reason === 'per_day'
          ? `今天已经出了 ${today()} 张（每天上限 ${DESIGN_CAPS.max_generations_per_day} 张）`
          : reason === 'per_run_images'
            ? `这件事这一轮已经出了 ${used.images} 张（单次上限 ${IMAGE_CAPS.per_run_images} 张）`
            : `这件事这一轮已经花了 ${used.credits} 积分（单次上限 ${IMAGE_CAPS.per_run_credits} 积分）`
      const item = await card({
        ctx,
        kind: 'image_budget',
        title: cost.own_key
          ? `还要再出 ${job.n} 张图吗？`
          : `再出 ${job.n} 张图，约 ${cost.total} 积分，要继续吗？`,
        summary: `${why}。批了才出，不批一分不花。`,
        payload,
        seen: [],
      })
      emit('image.budget_asked', { run_id: ctx.run_id, reason, images: job.n, credits: cost.total })
      return {
        status: 'ok',
        data: {
          kind: 'image_budget',
          status: 'needs_approval',
          approval_item_id: item.id,
          credits: cost.total,
          message: `${why}，这次先没出图，出了一张卡问人要不要继续（约 ${cost.total} 积分）。别再重试，等人批。`,
        },
      }
    }
    const r = await runJob(job, ctx)
    const where = job.place === undefined ? undefined : placeLabel(job.place)
    return {
      status: 'ok',
      data: {
        kind: 'image_pick',
        status: 'awaiting_pick',
        approval_item_id: r.item.id,
        asset_ids: r.assets.map((a) => a.id),
        credits: r.credits,
        message:
          `出了 ${r.assets.length} 张图，进了品牌素材库，事项里出了挑图卡等人挑` +
          `${r.own_key ? '（用自己的接口，不扣积分）' : `（花了 ${r.credits} 积分）`}。` +
          (where === undefined
            ? '人挑之前别把它当定稿。'
            : `人挑中后系统会自动传到店铺「文件」、写进${where}、推一份新预览——这一格你不用再改，接着做别的。`) +
          '别再重出同一批。',
      },
    }
  }

  const ctxOf = (request: RunRequest): JobCtx => ({
    run_id: request.id,
    role_id: request.actor.role_id,
    assignment_id: request.actor.assignment_id,
    person_id: request.actor.person_id,
    ...(request.work_item?.id === undefined ? {} : { matter_id: request.work_item.id }),
  })

  const listAssets = (input: Record<string, unknown>, request: RunRequest): unknown => {
    const limit = Math.max(1, Math.min(50, Math.floor(Number(input.limit ?? 20)) || 20))
    const tag = str(input.tag, 40)
    const rows = assets.list({
      ...(tag === undefined ? {} : { tag }),
      ...(input.this_matter === true && request.work_item?.id !== undefined
        ? { matter_id: request.work_item.id }
        : {}),
      status: ['variant', 'picked', 'published'],
      limit,
    })
    return {
      assets: rows.map((a) => ({
        id: a.id,
        status: a.status === 'variant' ? 'not_picked' : a.status,
        source:
          a.provenance.origin?.kind === 'shop_product'
            ? 'shop_product'
            : a.provenance.origin?.kind === 'matter_upload'
              ? 'dragged_in'
              : a.provenance.source,
        tags: a.tags ?? [],
        ...(a.width === undefined ? {} : { size: `${a.width}x${a.height ?? '?'}` }),
        ...(a.shop_file === undefined ? {} : { in_shop_files: a.shop_file.theme_ref }),
        created_at: a.created_at,
      })),
    }
  }

  const executeTool: ToolExecutor = async ({ name, input, request }) => {
    const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
    if (!IMAGE_TOOL_NAMES.includes(bare))
      return { status: 'error', reason: `not_an_image_tool:${bare}` }
    if (!isImageRole(request.actor.role_id))
      return { status: 'blocked', reason: `${request.actor.role_id} 这条职责用不了「${bare}」。` }
    try {
      if (bare === LIST_BRAND_ASSETS_TOOL) return { status: 'ok', data: listAssets(input, request) }
      const operation = bare === EDIT_IMAGE_TOOL ? 'edit' : 'generate'
      void GENERATE_IMAGE_TOOL
      const job = await jobOf(operation, input, request)
      return await generateOrAsk(job, ctxOf(request))
    } catch (e) {
      if (e instanceof ImageToolError) return { status: e.status, reason: e.message }
      if (e instanceof BrandAssetError) return { status: 'error', reason: e.message }
      return { status: 'error', reason: `出图没成：${e instanceof Error ? e.message : String(e)}` }
    }
  }

  const optionOf = (item: ApprovalItem): string | undefined => {
    const edited = item.decision?.edited_payload as { selected_option_id?: unknown } | undefined
    return (
      item.decision?.selected_option_id ??
      (typeof edited?.selected_option_id === 'string' ? edited.selected_option_id : undefined)
    )
  }
  const approved = (item: ApprovalItem): boolean =>
    item.state === 'approved' || item.state === 'approved_edited' || item.state === 'applied'

  const ctxFromPick = (item: ApprovalItem, p: { run_id: string; matter_id?: string }): JobCtx => ({
    run_id: p.run_id,
    role_id: item.role_id,
    assignment_id: (item.proposer.assignment_id as string | undefined) ?? '',
    person_id:
      item.decision?.by !== undefined && item.decision.by !== 'mandate'
        ? item.decision.by
        : (item.routing.recipients[0]?.person ?? ''),
    ...(p.matter_id === undefined ? {} : { matter_id: p.matter_id }),
  })

  const onDecided = async (item: ApprovalItem): Promise<boolean> => {
    if (item.workspace_id !== workspace_id) return false
    if (item.kind === 'image_budget') {
      const p = item.payload as ImageBudgetPayload
      if (p?.form !== 'image_budget') return true
      if (!approved(item)) {
        note(p.matter_id, '好，这批图不出了，一分没花。')
        return true
      }
      try {
        const ctx = ctxFromPick(item, p)
        ctx.role_id = p.role_id
        ctx.assignment_id = p.assignment_id
        const r = await runJob(p.job, ctx)
        note(p.matter_id, `出了 ${r.assets.length} 张图，在下面挑一张。`)
      } catch (e) {
        note(p.matter_id, `图没出成：${e instanceof Error ? e.message : String(e)}`)
      }
      return true
    }
    if (item.kind !== 'image_pick') return false
    const p = item.payload as ImagePickPayload
    if (p?.form !== 'image_pick') return true
    const by = item.decision?.by === 'mandate' ? undefined : item.decision?.by
    const now = clock.now()
    const markAll = (status: DesignAsset['status']): void => {
      for (const v of p.variants) {
        const a = assets.get(v.asset_id)
        if (a !== undefined && a.status === 'variant') assets.update({ ...a, status })
      }
    }
    if (!approved(item)) {
      if (item.state === 'rejected') {
        markAll('rejected')
        note(p.matter_id, '这批图都不要，已记下（下一版会避开）。')
        emit('image.rejected', { run_id: p.run_id, images: p.variants.length })
      }
      return true
    }
    const choice = optionOf(item)
    if (choice === IMAGE_PICK_AGAIN) {
      markAll('rejected')
      const ctx = ctxFromPick(item, p)
      const r = await generateOrAsk(p.job, ctx).catch(
        (e: unknown): ToolExecution => ({
          status: 'error',
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
      note(
        p.matter_id,
        r.status === 'ok'
          ? (r.data as { status?: string }).status === 'needs_approval'
            ? '再来一版要超单次上限，出了一张卡问你。'
            : '又出了一版，在下面挑。'
          : `再来一版没出成：${r.reason ?? ''}`,
      )
      return true
    }
    const picked = p.variants.find((v) => v.id === choice)
    const asset = picked === undefined ? undefined : assets.get(picked.asset_id)
    if (asset === undefined) {
      note(p.matter_id, '选的那张在素材库里找不到了。')
      return true
    }
    const marked: DesignAsset = {
      ...asset,
      status: 'picked',
      provenance: {
        ...asset.provenance,
        ...(by === undefined ? {} : { picked_by: by }),
        picked_at: now,
      },
    }
    assets.update(marked)
    emit('image.picked', { run_id: p.run_id, asset_id: asset.id, upload: p.upload })
    if (p.job.place === undefined || options.place === undefined) {
      note(p.matter_id, `选了${picked?.label ?? '这一张'}，进素材库了。`)
      return true
    }
    note(
      p.matter_id,
      `选了${picked?.label ?? '这一张'}，正在传到店铺「文件」、挂到${placeLabel(p.job.place)}…`,
    )
    const out = await options
      .place({
        asset: marked,
        target: p.job.place,
        ...(p.matter_id === undefined ? {} : { matter_id: p.matter_id }),
        ...(by === undefined ? {} : { by }),
      })
      .catch(
        (e: unknown): PlaceOutcome => ({
          ok: false,
          message: `没挂上：${e instanceof Error ? e.message : String(e)}`,
        }),
      )
    note(p.matter_id, out.message)
    emit('image.placed', { asset_id: asset.id, ok: out.ok })
    return true
  }

  return {
    executeTool,
    async offered(role_id) {
      if (!isImageRole(role_id)) return []
      const p = options.images()
      if (p === undefined || !p.available) return []
      return IMAGE_TOOL_NAMES.filter((n) => n !== EDIT_IMAGE_TOOL || p.edit !== undefined)
    },
    onDecided,
  }
}
