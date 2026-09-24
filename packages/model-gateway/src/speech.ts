/**
 * WP145：语音识别器的「选择层」——所有调 `transcribe` 的地方都先经过这里。
 *
 * 接口形状对齐官方 `ctx.speechToText`（`@deepseek-ai/dsh-experimental-speech-to-text`
 * @ `dsh-v0.1.7-rc.1`）：具名 provider、`resolve` → `transcribe`、`languages`、
 * `prepare` / `downloadSources`。只对齐形状，没有依赖官方包，也**没有装任何本机识别器**。
 *
 * Luoye 09-24 定：先不走本地（机器要求高、各平台方案不同、安装包会大很多），留个口。
 * 现在只注册一个内置识别器 `model-gateway`：照旧走模型网关——用云端（积分）还是
 * 自带模型 key，由「设置 → 模型」决定，和以前逐字相同。
 * 以后加一个本机识别器 = `speech.register(provider)` + `configure({ providerId })`，
 * 调用方（会议管线等）一行不用改。
 */

import type {
  ModelMeta,
  ModelRef,
  Transcription,
  TranscriptionAudioDigest,
  TranscriptionSegment,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import type { ModelGatewayApi, TranscribeRequest } from './gateway.js'

/** 识别器的名字（注册时给定，选择时按它精确匹配）。 */
export type SpeechProviderId = string

/** 内置识别器：走模型网关（云端积分 / 自带模型 key，跟随模型设置）。 */
export const GATEWAY_SPEECH_PROVIDER_ID: SpeechProviderId = 'model-gateway'

/** 安装前的估算（不是实测进度，也不是保证）。 */
export interface SpeechSetupEstimate {
  readonly recommendedDiskBytes: number
  readonly expectedMemoryBytes: number
  readonly minimumMinutes: number
  readonly maximumMinutes: number
}

/** 识别器的公开信息；不含凭据、不含本机路径。 */
export interface SpeechProviderInfo {
  readonly id: SpeechProviderId
  /** 给人看的名字。 */
  readonly name: string
  readonly location: 'host-local' | 'cloud'
  /**
   * 谁记账：`gateway` = 走模型网关的预算与账目（云端积分或自带 key）；
   * `none` = 不经网关、不扣积分（本机识别器就是这一档）。
   */
  readonly billing: 'gateway' | 'none'
  /** 接受的语言提示；**空数组 = 不限制，原样转交**（网关那一家自己判）。 */
  readonly languages: readonly string[]
  readonly setupEstimate?: SpeechSetupEstimate
  /** 准备（下载模型）时可选的来源；不需要下载的识别器不填。 */
  readonly downloadSources?: readonly string[]
}

/** 准备状态（形状同官方 `SpeechPreparationState` 的主干）。 */
export type SpeechPreparationState =
  | { readonly phase: 'unprepared' | 'ready' | 'standby' | 'cancelled' }
  | {
      readonly phase: 'downloading'
      readonly resource: string
      readonly completedBytes: number
      readonly totalBytes?: number
    }
  | {
      readonly phase: 'checking' | 'loading' | 'waking' | 'cancelling'
      readonly startedAt: number
    }
  | { readonly phase: 'failed'; readonly message: string }

export interface SpeechPreparationOptions {
  /** 这一次准备用哪个下载源（必须是 `downloadSources` 里的一个）。 */
  readonly downloadSource?: string
}

/** 可选的准备口：要下模型的识别器才有；没有就是「装上即可用」。 */
export interface SpeechPreparation {
  snapshot(): SpeechPreparationState
  subscribe(listener: () => void): () => void
  prepare(options?: SpeechPreparationOptions): void
  cancel(): Promise<void>
}

/** 一次转写的上下文：记账用的 meta、调用方指定的模型、取消信号。 */
export interface SpeechContext {
  readonly meta: ModelMeta
  readonly model?: ModelRef
  /** 调用方取消或识别器被撤下时触发；识别器必须响应。 */
  readonly signal: AbortSignal
}

/** 一个可替换的识别器：自己负责准备、执行与取消。 */
export interface SpeechProvider {
  readonly info: SpeechProviderInfo
  readonly preparation?: SpeechPreparation
  transcribe(input: TranscribeRequest, context: SpeechContext): Promise<Transcription>
}

/** 调用方的选择；不填的走当前默认。 */
export interface SpeechRequest {
  readonly input: TranscribeRequest
  readonly providerId?: SpeechProviderId
  readonly language?: string
}

/** 解析后的选择：钉住当时注册的那一个识别器（被撤下或换掉后就不能再用）。 */
export interface SpeechSpec {
  readonly provider: SpeechProvider
  readonly input: TranscribeRequest
  /** 内部：注册凭据，用来判断「是不是还是那一个」。 */
  readonly registration: object
}

export interface SpeechSelection {
  readonly providerId: SpeechProviderId
  /** 默认语言提示；不填 = 不替调用方补语言（与 WP145 以前逐字相同）。 */
  readonly language?: string
}

export interface SpeechProviderView extends SpeechProviderInfo {
  readonly preparation: SpeechPreparationState
}

export type SpeechErrorCode =
  | 'provider_missing'
  | 'provider_duplicate'
  | 'provider_withdrawn'
  | 'unsupported_language'
  | 'bad_download_source'

export class SpeechError extends Error {
  readonly code: SpeechErrorCode
  constructor(code: SpeechErrorCode, message: string) {
    super(message)
    this.name = 'SpeechError'
    this.code = code
  }
}

/** 选择层本身（官方 `ctx.speechToText` 的对应物）。 */
export interface SpeechToText {
  /** 注册一个识别器；返回撤下函数（撤下时正在跑的转写会被取消）。重名直接报错。 */
  register(provider: SpeechProvider): () => void
  /** 现在有哪些识别器（含准备状态）。 */
  providers(): SpeechProviderView[]
  selection(): SpeechSelection
  /** 改默认识别器 / 默认语言；选了没注册的、或该识别器不认的语言，直接报错不保存。 */
  configure(patch: { providerId?: SpeechProviderId; language?: string }): SpeechSelection
  /** 开始（或加入）某个识别器的准备；没有准备口的识别器什么也不做。 */
  prepare(providerId: SpeechProviderId, options?: SpeechPreparationOptions): void
  /** 在执行前把选择定下来：哪一个识别器、什么语言。 */
  resolve(request: SpeechRequest): SpeechSpec
  /** 按解析结果转写；识别器已被撤下或替换就拒绝，不偷偷换一个。 */
  transcribe(spec: SpeechSpec, meta: ModelMeta, model?: ModelRef): Promise<Transcription>
}

export interface SpeechToTextOptions {
  /** 内置识别器走的网关（只用它的 `transcribe`）。 */
  gateway: Pick<ModelGatewayApi, 'transcribe'>
  /** 默认识别器；不填 = `model-gateway`。 */
  defaultProvider?: SpeechProviderId
  /** 默认语言提示；不填 = 不补。 */
  language?: string
}

/** 内置识别器：原样交给模型网关（计费、事件、错误话术都是网关那一套）。 */
export function gatewaySpeechProvider(
  gateway: Pick<ModelGatewayApi, 'transcribe'>,
): SpeechProvider {
  return {
    info: {
      id: GATEWAY_SPEECH_PROVIDER_ID,
      name: '云端（积分）或自带模型 key（跟随模型设置）',
      location: 'cloud',
      billing: 'gateway',
      languages: [],
    },
    transcribe: (input, context) =>
      context.model === undefined
        ? gateway.transcribe(input, context.meta)
        : gateway.transcribe(input, context.meta, context.model),
  }
}

interface Registration {
  readonly provider: SpeechProvider
  readonly inflight: Set<AbortController>
}

export function createSpeechToText(options: SpeechToTextOptions): SpeechToText {
  const registry = new Map<SpeechProviderId, Registration>()
  let selection: SpeechSelection = {
    providerId: options.defaultProvider ?? GATEWAY_SPEECH_PROVIDER_ID,
    ...(options.language === undefined ? {} : { language: options.language }),
  }

  const lookup = (id: SpeechProviderId): Registration => {
    const found = registry.get(id)
    if (found === undefined) throw new SpeechError('provider_missing', `没有这个识别器：${id}`)
    return found
  }
  const checkLanguage = (info: SpeechProviderInfo, language: string | undefined): void => {
    if (language === undefined || info.languages.length === 0) return
    if (!info.languages.includes(language))
      throw new SpeechError(
        'unsupported_language',
        `识别器「${info.name}」不认这个语言：${language}`,
      )
  }

  const api: SpeechToText = {
    register(provider) {
      const id = provider.info.id
      if (registry.has(id)) throw new SpeechError('provider_duplicate', `识别器重名：${id}`)
      const reg: Registration = { provider, inflight: new Set() }
      registry.set(id, reg)
      return () => {
        if (registry.get(id) !== reg) return
        registry.delete(id)
        for (const c of reg.inflight)
          c.abort(new SpeechError('provider_withdrawn', `识别器已撤下：${id}`))
      }
    },
    providers: () =>
      [...registry.values()].map(({ provider }) => ({
        ...provider.info,
        preparation: provider.preparation?.snapshot() ?? { phase: 'ready' },
      })),
    selection: () => selection,
    configure(patch) {
      const providerId = patch.providerId ?? selection.providerId
      const language = patch.language ?? selection.language
      checkLanguage(lookup(providerId).provider.info, language)
      selection = { providerId, ...(language === undefined ? {} : { language }) }
      return selection
    },
    prepare(providerId, prepOptions) {
      const { provider } = lookup(providerId)
      const source = prepOptions?.downloadSource
      if (source !== undefined && !(provider.info.downloadSources ?? []).includes(source))
        throw new SpeechError('bad_download_source', `这个识别器没有这个下载源：${source}`)
      provider.preparation?.prepare(prepOptions)
    },
    resolve(request) {
      const reg = lookup(request.providerId ?? selection.providerId)
      const language = request.language ?? request.input.language ?? selection.language
      checkLanguage(reg.provider.info, language)
      // 语言没变就原对象交出去：没注册别的识别器时，网关拿到的入参与以前逐字相同
      const input =
        language === undefined || language === request.input.language
          ? request.input
          : { ...request.input, language }
      return { provider: reg.provider, input, registration: reg }
    },
    async transcribe(spec, meta, model) {
      const reg = registry.get(spec.provider.info.id)
      if (reg === undefined || reg !== spec.registration)
        throw new SpeechError(
          'provider_withdrawn',
          `识别器已撤下或被替换：${spec.provider.info.id}`,
        )
      const controller = new AbortController()
      reg.inflight.add(controller)
      try {
        const context: SpeechContext = {
          meta,
          signal: controller.signal,
          ...(model === undefined ? {} : { model }),
        }
        return await reg.provider.transcribe(spec.input, context)
      } finally {
        reg.inflight.delete(controller)
      }
    },
  }
  api.register(gatewaySpeechProvider(options.gateway))
  return api
}

/** 本机识别器吐出来的东西（没有 token、没有价钱）。 */
export interface LocalSpeechResult {
  text: string
  segments: TranscriptionSegment[]
  speakers?: string[]
  language?: string
  /** 模型名；不填就用识别器 id。 */
  model?: string
}

/**
 * 给**不经网关**的识别器用：把识别结果补成完整的 `Transcription`——用量记 0、
 * `model` 记成这个识别器、`audio` 只留摘要（同网关那条纪律：音频字节不进任何日志）。
 */
export function localTranscription(
  providerId: SpeechProviderId,
  input: TranscribeRequest,
  result: LocalSpeechResult,
): Transcription {
  return {
    text: result.text,
    segments: result.segments,
    ...(result.speakers === undefined ? {} : { speakers: result.speakers }),
    ...(result.language === undefined ? {} : { language: result.language }),
    usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_base: 0 },
    model: { provider: providerId, model: result.model ?? providerId },
    audio: speechAudioDigest(input),
  }
}

/** 音频摘要（与网关 `transcribe` 记进 `model.usage` 的那一份同算法）。 */
export function speechAudioDigest(input: TranscribeRequest): TranscriptionAudioDigest {
  let hex = ''
  for (const b of input.bytes) hex += b.toString(16).padStart(2, '0')
  return {
    sha256: sha256(hex),
    duration_ms: input.duration_ms ?? 0,
    bytes: input.bytes.byteLength,
    mime: input.mime,
  }
}
