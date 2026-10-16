/**
 * WP355（Luoye 10-16，决策 937）：**哪些模型来源用它自带的联网搜索**——由我们定的名单（代码里的常量，
 * 不给用户开关）。
 *
 * Luoye 原话：不是所有都用 AI 自带搜索，只有我指定的用，例如用户用的是 ChatGPT 订阅那个，就用 AI 自带的搜索。
 *
 * 第一版名单只有 ChatGPT 订阅登录（`openai-codex`）。其余（DeepSeek、工坊积分、各家 API key…）照旧走
 * WP353 的链（内置浏览器 Google → Bing → 云端 Google → 公开搜索服务）。名单里的来源搜不成、没登录、
 * 没真的去搜，都自动退回 WP353 的链，结果上照实写「来自哪一路」。
 *
 * 「模型来源」= 这次运行的 `RunRequest.runtime.model.provider`（随便聊 / 助理用品牌默认模型那一条）。
 * 订阅运行的 provider 名就是 `openai-codex`（dsh 那一层按这个名字挂官方订阅适配器，见 dsh-adapter `harness.ts`）。
 */
import type { SearchSource } from './search.js'

/** 用自带联网搜索的模型来源（决策 937）。加一家 = 在这里加一行，并在下面接上它的搜索。 */
export const NATIVE_SEARCH_SOURCES = ['openai-codex'] as const

export type NativeSearchSource = (typeof NATIVE_SEARCH_SOURCES)[number]

/** 这个模型来源在不在名单里（不在 = 走 WP353 的链）。 */
export function nativeSearchSourceOf(source: string | undefined): NativeSearchSource | undefined {
  return (NATIVE_SEARCH_SOURCES as readonly string[]).includes(source ?? '')
    ? (source as NativeSearchSource)
    : undefined
}

/** 给人看的名字（结果第一句「这次的结果来自……」）。 */
export const NATIVE_SEARCH_LABEL: Record<NativeSearchSource, string> = {
  'openai-codex': 'ChatGPT 自带搜索',
}

/** 这一次搜索是谁、用的哪个模型（宿主现给；判名单、取哪个人的订阅都看它）。 */
export interface SearchWho {
  /** 模型来源（`ModelRef.provider`）。 */
  source?: string
  /** 模型名（自带搜索用同一个模型问；目录里没有就退回默认）。 */
  model?: string
  /** 谁在用（订阅账号按人分开）。 */
  person_id?: string
}

/** 宿主接的「自带搜索」口（产品里接的是订阅登录那棵树，测试给替身）。 */
export interface NativeSearchPort {
  search(input: {
    source: NativeSearchSource
    person_id?: string
    model?: string
    query: string
    maxResults: number
    locale: { language: string; market?: string }
    signal?: AbortSignal
  }): Promise<{
    sources: readonly SearchSource[]
    model?: string
    usage?: { input_tokens: number; output_tokens: number; cached_tokens: number }
  }>
}
