/**
 * WP246：两个零配置的只读工具真去取数——`read_youtube_transcript`（YouTube 字幕）与 `read_webpage`（网页转文字）。
 *
 * 与 `read_reddit` 同一个口径：没取到回 `status: 'ok'` + 一句人话（`missing`），不当错误抛——
 * 研究那一边要把「从哪取的、为什么没取到」写进报告；每次结果附一条来源（哪一级、经没经第三方）。
 * 每次都记进取数路线的小账（体检里「上次没成：……」那一句）。
 *
 * 这一跳不往外写任何东西；正文是外部文本，由运行时围栏后再进模型上下文。
 */
import { READ_WEBPAGE_TOOL, YOUTUBE_TRANSCRIPT_TOOL } from '@agentsws/contracts'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import type { ReadRoutesStore } from './store.js'
import { readWebpage, type WebReadOptions } from './webpage.js'
import { readYoutubeTranscript, type TranscriptOptions } from './youtube.js'

export const READ_ROUTE_TOOL_NAMES: readonly string[] = [YOUTUBE_TRANSCRIPT_TOOL, READ_WEBPAGE_TOOL]

export interface ReadToolsOptions {
  /** 不给 = 这个进程不出网读（测试 / 模拟 / 演示），照实说「没装」。 */
  youtube?: TranscriptOptions
  web?: WebReadOptions
  store: ReadRoutesStore
  nowMs(): number
}

const bareOf = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name

const NOT_INSTALLED = '这个服务进程没装出网读取（演示 / 测试环境），这次没读。'

export function createReadToolExecutor(options: ReadToolsOptions): ToolExecutor {
  const at = (): string => new Date(options.nowMs()).toISOString()
  return async (call): Promise<ToolExecution> => {
    const name = bareOf(call.name)
    if (name === YOUTUBE_TRANSCRIPT_TOOL) {
      const video =
        typeof call.input.video === 'string' ? call.input.video : (call.input.url as unknown)
      if (typeof video !== 'string' || video.trim() === '')
        return { status: 'error', reason: '要给 video（YouTube 视频网址或 11 位视频 id）。' }
      if (options.youtube === undefined)
        return { status: 'ok', data: { ok: false, missing: NOT_INSTALLED } }
      const lang =
        typeof call.input.lang === 'string' && call.input.lang !== '' ? call.input.lang : undefined
      const r = await readYoutubeTranscript(options.youtube, {
        video,
        ...(lang === undefined ? {} : { lang }),
      })
      if (r.failure !== 'bad_input')
        options.store.note('youtube', 'page_captions', r.ok, at(), r.ok ? undefined : r.message)
      if (r.failure === 'bad_input') return { status: 'error', reason: r.message ?? '认不出视频。' }
      const { message, ...rest } = r
      return {
        status: 'ok',
        data: {
          ...rest,
          source: { platform: 'youtube', level: 'page_captions', third_party: false },
          ...(r.ok ? {} : { missing: message }),
        },
      }
    }
    if (name === READ_WEBPAGE_TOOL) {
      const url = typeof call.input.url === 'string' ? call.input.url.trim() : ''
      if (url === '') return { status: 'error', reason: '要给 url（要读的网址）。' }
      if (options.web === undefined)
        return { status: 'ok', data: { ok: false, missing: NOT_INSTALLED } }
      const r = await readWebpage(options.web, { url })
      for (const a of r.attempts)
        if (a.level !== 'third_party_reader' || options.web.thirdParty())
          options.store.note('web', a.level, a.ok, at(), a.message)
      const { message, attempts, via, ...rest } = r
      return {
        status: 'ok',
        data: {
          ...rest,
          source: {
            platform: 'web',
            ...(via === undefined ? {} : { level: via }),
            third_party: via === 'third_party_reader',
            attempts,
          },
          ...(r.ok ? (message === undefined ? {} : { notice: message }) : { missing: message }),
        },
      }
    }
    return { status: 'error', reason: `unsupported_tool: ${call.name}` }
  }
}

/** 研究工具链：`read_reddit` 交给原来那个执行器，WP246 这两个交给这里。 */
export function chainResearchTools(reddit: ToolExecutor, reads: ToolExecutor): ToolExecutor {
  return (call) => (READ_ROUTE_TOOL_NAMES.includes(bareOf(call.name)) ? reads(call) : reddit(call))
}
