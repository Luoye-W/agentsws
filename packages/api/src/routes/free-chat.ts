/**
 * WP188「随便聊」：像 DeepSeek 网页版一样的自由对话入口。
 *
 * 三条边界，全部在这里与宿主实现（`apps/server/src/free-chat.ts`）兑现：
 * 1. **不开事项、不起岗位运行、没有任何对外动作**：模型手上只有「联网搜索」一个工具（开关开着才挂），
 *    「用公司资料回答」是回答前只读地查一次知识库，不是工具；
 * 2. **会话存本机**，和事项分开；只有本人看得见自己的会话；
 * 3. **计量照常**：每一次模型调用都过模型网关（用途 `free_chat`），积分照常扣，不另写扣费。
 *
 * WP343（决策 334 / 859）：随便聊改名「我的助理」（包名 / 路由 / 事件名不动）。第 1 条边界放宽：
 * 模型手上多了四个**只读**工具（各岗位在做什么、今天要我处理的卡、最近发出去的、某件事进展）与
 * 一个**派活**工具——它不自己做，挑好岗位 / 职责、走岗位的交办入口开一件事，那个岗位去办；
 * 改外部的事照旧由那个岗位出审批，助理自己没有任何对外的写口。交出去的事有结果 / 要拍板时
 * 回到这段对话里报一句（`report`）。
 *
 * 发一句（与重新生成）回的是 **SSE**（`text/event-stream`），不是统一信封——与聊天沙盒同一种写法
 * （`fetch` + `ReadableStream`，凭据在头里，不进 URL）。客户端断开 = 停；另有一条 `stop` 兜底。
 */
import type { ArchivedWorkCandidate, FactCard, ReasoningEffort } from '@agentsws/contracts'
import { REASONING_EFFORTS } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

export interface FreeChatActor {
  workspace_id: string
  person_id: string
  assignment_id: string
}

export interface FreeChatSessionView {
  id: string
  title: string
  created_at: string
  updated_at: string
}

/** 联网搜索找到的一条来源。 */
export interface FreeChatSource {
  url: string
  title?: string
}

/** 「用公司资料回答」时引到的一条资料（回答里写成 [1]、[2]）。 */
export interface FreeChatCitation {
  n: number
  fact_card_id: string
  text: string
  /** 这条资料从哪来（人话：文档名 / 谁录的）。 */
  source?: string
}

export interface FreeChatImage {
  mime: string
  /** base64，不带 `data:` 前缀。 */
  data: string
}

export interface FreeChatMessageView {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  images?: FreeChatImage[]
  /** 这条回复用的哪个模型（`provider_id/model` + 人话名字）。 */
  model?: { id: string; label: string; official: boolean }
  /** 花了多少：token 总是有；走官方积分的那条再估一个积分数（以云上账单为准）。 */
  usage?: { input_tokens: number; output_tokens: number; credits?: number }
  sources?: FreeChatSource[]
  citations?: FreeChatCitation[]
  web_search?: boolean
  knowledge?: boolean
  /** 用户中途点了停。 */
  stopped?: boolean
  /** 这一轮没答出来（人话）。 */
  error?: string
  /**
   * WP425：这一轮从自己的 AI 切到了工坊积分——那一句（「你的 ChatGPT 额度用完了，这一轮用工坊积分」），
   * 界面在回复上方照实一行。`model` 那时已是工坊积分那一条。
   */
  source_switch?: string
  /**
   * WP430（决策 1290）：切过来源的那一轮，原来选的是哪一个（`provider/model`）。`model` 是实际答的那一条；
   * 界面的 AI 钮按这一格回到原选——下一轮先试原选，而不是跟着切过去的那一条走。
   */
  chosen_model?: string
  /**
   * WP425：自己的 AI 用不了、开关「自己的用不了时用工坊积分接着做」关着——这一轮照实停下，
   * 界面在这条下面出「用工坊积分接着做」那张卡（点了打开开关、重答这一轮）。
   */
  source_fallback_off?: boolean
  /**
   * WP207：这一轮模型调了只读的 `find_archived_work`，找到的候选（最像的 3–5 个）。
   * 界面上是一排卡片，**人点了哪张才恢复哪张**；模型自己恢复不了任何东西。
   */
  archived_candidates?: ArchivedWorkCandidate[]
  /** WP343：用户这句是 `@` 给谁的（「Reddit 运营 · 官方版块」，只用来显示）。 */
  to?: string
  /** WP343：这一轮交给岗位去做的事（对话里那一行「已交给 X · Y」，点了进那件事）。 */
  dispatches?: FreeChatDispatchView[]
  /** WP343：这一条是交出去的事回来报的一句（不是模型答的，没有 `model` / `usage`）。 */
  report?: FreeChatReportView
  /** WP350：用户这句附上的文本类资料（界面只显示名字与字数；读出来的字只给模型看）。 */
  attachments?: FreeChatAttachment[]
  /** WP350：助理拆好的「我打算这样分」方案卡（人点「就这样」才派、才记）。 */
  fanout?: FreeChatFanoutView
  /** WP350：方案卡确认之后的那张汇总（派了哪几个岗位几件事、各进了几条知识）。 */
  fanout_summary?: FreeChatFanoutSummaryView
  /** WP352：这条话属于长对话里的哪一段话题（界面在段与段之间画分隔线 + 一行小结）。 */
  segment_id?: string
  /** WP352：这一轮助理翻了以前聊过的，查回来的出处（点了跳到那里）。 */
  recalled?: AssistantHistoryHitView[]
}

/** WP352：长对话里的一段话题。 */
export interface AssistantSegmentView {
  id: string
  started_at: string
  ended_at?: string
  /** 为什么切的：第一段 / 隔久了 / 跨天 / 话题变了 / 人换的 / 老会话迁来的。 */
  reason: 'first' | 'gap' | 'day' | 'topic' | 'manual' | 'migrated'
  /** 一行小结（分隔线上那一行）；还没小结出来就没有。 */
  title?: string
  /** 话题小结（谁、要做什么、定了什么、派了哪些事）。 */
  summary?: string
  /** 正在聊的这一段。 */
  current: boolean
}

/** WP352：助理那一条长对话（老的多条会话第一次打开时按时间拼进来）。 */
export interface AssistantThreadView {
  session: FreeChatSessionView
  segments: AssistantSegmentView[]
}

/**
 * WP511（决策 1546）：以前某一段的原话（一页）。第三栏「打开那一段」用：小结 / 出处点了在右边开当时的原话。
 * 附件照旧只有名字与字数。
 */
export interface AssistantSegmentPageView {
  segment: AssistantSegmentView
  /** 这条长对话里第几段（1 起；小结与翻旧账里写的「第 N 段」）。 */
  n: number
  /** 这一页从第几句起（1 起）。 */
  from: number
  /** 这一段一共几句。 */
  total: number
  messages: FreeChatMessageView[]
}

/** WP352：在以前聊过的里面搜到的一处（小结或原话），带出处。 */
export interface AssistantHistoryHitView {
  segment_id: string
  /** 原话那一条；命中的是小结时没有（跳到那段开头）。 */
  message_id?: string
  kind: 'message' | 'summary'
  at: string
  role?: 'user' | 'assistant'
  /** 那一段的一行小结。 */
  title?: string
  /** 命中那一小段（前后几十个字）。 */
  snippet: string
  /** WP511：这条长对话里第几段（1 起）。 */
  segment_n?: number
  /** WP511：那一段里第几句（1 起；命中小结时没有）。 */
  message_n?: number
  /** WP511：命中的是这句话附上的资料（名字）。 */
  attachment?: string
}

/** WP350：用户附上的一份文本类资料（.txt / .md / .docx / .pdf / 粘贴的长文本；WP357 加 .xlsx / .csv，读成表格文字）。 */
export interface FreeChatAttachment {
  name: string
  /** 读出来多少字（读不出 = 0）。 */
  chars: number
  /** 读出来的字（只在服务端会话里留着、进模型时当外部资料围起来；列会话时不回给界面）。 */
  text?: string
  /** 读不出时的一句人话。 */
  unreadable?: string
  /** 像口令 / 密钥的字抹掉了几处（决策 814：只有密钥不经 AI）。 */
  redacted?: number
}

/** WP350：方案卡上的一条。 */
export interface FreeChatFanoutItemView {
  id: string
  /** `task` 要做的事 / `note` 要记住的业务口径 / `memory` 本人的偏好（进助理记忆）。 */
  kind: 'task' | 'note' | 'memory'
  text: string
  why?: string
  due?: string
  /** 原文出处（资料里那一段）。 */
  quote?: string
  position_id?: string
  position_name?: string
  role_id?: string
  duty_name?: string
  /** 要记的那条进品牌公共知识。 */
  brand?: boolean
  /** 归属待定：认不出该归哪个岗位（人在卡上挑；不挑不发）。 */
  unsure?: { reason: string }
  /** 像口令：不进知识、不进记忆。 */
  secret?: boolean
}

/** WP350：助理拆好的方案卡。 */
export interface FreeChatFanoutView {
  /** 这一批的「来源批次」：开出去的事、写进去的知识都带它。 */
  batch_id: string
  title: string
  source: { name: string; kind: 'meeting' | 'document' | 'human' }
  items: FreeChatFanoutItemView[]
  /** 改归属能挑的岗位与职责（本人的）。 */
  positions: { position_id: string; name: string; duties: { role_id: string; name: string }[] }[]
  /** `proposed` 等人点 / `sent` 派好了 / `dismissed` 人说不用了。 */
  status: 'proposed' | 'sent' | 'dismissed'
  at: string
}

/** WP350：方案卡确认之后的汇总。 */
export interface FreeChatFanoutSummaryView {
  batch_id: string
  title: string
  /** 按岗位：几件事（开出来的那几件）、几条知识。 */
  groups: {
    position_id: string
    name: string
    tasks: { matter_id: string; title: string }[]
    notes: number
  }[]
  brand_notes: number
  memories: number
  /** 没发的：勾掉的 / 归属待定的 / 像口令的。 */
  skipped: { dropped: number; unsure: number; secret: number }
  /** 要记的那几条等人确认的那张卡（WP350；WP357 决策 902 起不再出这张卡，只有老数据带）。 */
  knowledge_card_id?: string
  /** WP357（决策 902）：要记的那几条写进知识库后的条目 id（已生效；汇总卡上「撤销」撤的就是它们）。 */
  note_card_ids?: string[]
  /** WP357：人在汇总卡上点了「撤销」的时候；撤了几条。 */
  notes_undone_at?: string
  notes_undone?: number
  /** 开事项 / 写知识里没成的（人话）。 */
  failed?: string[]
  at: string
}

/** WP350：人在方案卡上对一条的改动。 */
export interface FreeChatFanoutEditInput {
  id: string
  drop?: boolean
  position_id?: string
  role_id?: string
  brand?: boolean
  text?: string
}

/** WP343：助理交给岗位的一件事。 */
export interface FreeChatDispatchView {
  matter_id: string
  /** 事项标题。 */
  title: string
  position_id: string
  position_name: string
  /** 判准了职责才有（岗位里还没分的时候没有）。 */
  role_id?: string
  duty_name?: string
  at: string
  /** WP350：同一张方案卡派出去的带同一个来源批次。 */
  batch_id?: string
}

/** WP343：交出去的事回来报一句——做完了 / 要你拍板 / 没做成。 */
export interface FreeChatReportView {
  matter_id: string
  kind: 'done' | 'decide' | 'failed'
  position_name: string
  duty_name?: string
  /** `decide` 那一张卡。 */
  approval_item_id?: string
  /** WP350：这件事是哪一批派出去的（界面按批次聚在一起）。 */
  batch_id?: string
  batch_title?: string
}

/** WP343：输入框下面的一个快捷问题（按当前状态生成，不写死）。 */
export interface AssistantSuggestionView {
  text: string
  /** `cards` 有卡要处理 / `position` 某岗位今天做了什么 / `dispatch` 派活例句 / `create_position` 去建岗位 */
  kind: 'cards' | 'position' | 'dispatch' | 'create_position'
  /** 点了不发话、直接去这一页（`create_position`）。 */
  href?: string
}

/** WP343：输入框里 `@` 能选的一个岗位（与它下面本人持有的职责）。 */
export interface AssistantTargetView {
  position_id: string
  name: string
  duties: { role_id: string; name: string }[]
}

/** WP343：「我的助理」这一层记的一条（本人的，只在助理对话里用；AI 记的可删，删了不再记回来）。 */
export interface AssistantMemoryView {
  id: string
  text: string
  at: string
  written_by: 'ai' | 'person'
}

/** WP343：「我的助理」这一页的状态：快捷问题（≤ 4）与 `@` 能选的岗位。 */
export interface AssistantStateView {
  suggestions: AssistantSuggestionView[]
  targets: AssistantTargetView[]
}

export interface FreeChatModelChoice {
  /** `provider_id/model`。 */
  id: string
  label: string
  /** 「Agents 工坊云（用积分）」那一条。 */
  official: boolean
  /** 能不能看图（按上一次三步验证）：`unchecked` = 没验证过，照常让贴图。 */
  vision: 'ok' | 'no' | 'unchecked'
  /** WP362（只加）：哪一组——`workshop` 工坊积分 / `subscription` ChatGPT 订阅 / `own` 自己接的。 */
  group?: 'workshop' | 'subscription' | 'own'
  /** WP362：厂商（`openai` / `deepseek` / `qwen`…，图标用；认不出不给）。 */
  vendor?: string
  /** WP362：每行右边那一格。 */
  price?: FreeChatModelPrice
  /**
   * WP370（只加）：给人看的模型名（目录里有就给：ChatGPT 订阅「GPT-5.5」、DeepSeek 账号「DeepSeek-V4.1-Flash」）；
   * 没有就界面用 id 里的模型名。选择与保存一律用 `id`。
   */
  name?: string
  /** WP370：上下文窗口（token；目录里写了才有）。≥ 20 万界面标「长上下文」。 */
  context_window?: number
  /** WP370：这个来源**自带**联网搜索（ChatGPT 订阅用订阅的搜索，WP355）。别的模型照样能经内置浏览器搜。 */
  native_search?: boolean
  /** WP370：能调的思考程度（只给声明了档位的模型；没有 = 不出「思考」那一行）。 */
  thinking?: FreeChatModelThinking
}

/** WP370：思考程度的三档白话（界面只露这三个词）。 */
export type FreeChatThinkingLevel = 'fast' | 'standard' | 'deep'

/**
 * WP370：一个模型的思考程度。每档落到这个模型自己声明的那一档 id（官方同一套，见 `ReasoningEffort`）：
 * ChatGPT 订阅 快 = low / 标准 = medium / 深度 = high；DeepSeek 快 = low / 标准 = high / 深度 = max。
 * 选择存的是 `effort`；不选 = `default`（模型默认，界面算「标准」）。
 */
export interface FreeChatModelThinking {
  options: { level: FreeChatThinkingLevel; effort: ReasoningEffort }[]
  default: ReasoningEffort
  /**
   * WP373（只加）：这个模型官方只声明了「不想」和一档——界面画成开关。开 = `options[0].effort`，关 = `off`；
   * 不给 = 三档（快 / 标准 / 深度）。
   */
  toggle?: true
}

/**
 * WP362：AI 钮每行右边那一格。`rate` = 消耗速率（WP364 起按 token：我们实收单价 ÷ 我们卖 DeepSeek v4 Pro 的单价，v4 Pro = 1x；
 * `stats` = 用近 30 天真实 token 构成、`list_price` = 用典型构成）；`discount` = 我们的价 ÷ 这家官方标价；`free` = 限免；`subscription` = 订阅额度；`own_key` = 用你自己的 key。
 */
export type FreeChatModelPrice =
  | {
      kind: 'rate'
      rate: number
      source: 'stats' | 'list_price'
      /** WP363（决策 954）：折扣（`0 < d < 1`，0.1 = 一折）；没有就不给。倍率仍是原价口径。 */
      discount?: number
    }
  | { kind: 'free' }
  | { kind: 'subscription' }
  | { kind: 'own_key' }

export interface FreeChatModelsView {
  choices: FreeChatModelChoice[]
  /**
   * WP362：消耗速率的 1x 是哪个模型；`fallback` = 价目里没有 DeepSeek v4 Pro（或对不上），退回了默认模型。
   * 价目拿不到就没有。
   */
  rate_base?: { model: string; fallback: boolean }
  /** WP362：组标题问号里那一句白话（消耗速率怎么算的）。 */
  rate_note?: string
  /** 「设置 → 模型」里的默认模型（`provider_id/model`）；一条都没配时没有。 */
  default?: string
  web_search: {
    /** 现在搜得了吗（登录了 DeepSeek 账号或填了 DeepSeek 官方 key，且没被关掉）。 */
    available: boolean
    /** 搜不了时的一句人话。 */
    reason?: string
    /** 一轮回答最多搜几次（照 WP179 每运行上限）。 */
    max_searches: number
  }
  knowledge: { available: boolean }
}

/** SSE 的一帧。 */
export type FreeChatFrame =
  | { type: 'start'; user?: FreeChatMessageView; message_id: string }
  | { type: 'delta'; text: string }
  | { type: 'searching'; query: string }
  | { type: 'sources'; sources: FreeChatSource[] }
  | { type: 'notice'; text: string }
  /** WP207：找回归档的候选（卡片，人点选才恢复）。 */
  | { type: 'archived_candidates'; candidates: ArchivedWorkCandidate[] }
  /** WP343：交给了一个岗位（对话里马上出那一行）。 */
  | { type: 'dispatched'; dispatch: FreeChatDispatchView }
  /** WP350：方案卡摆出来了（人点「就这样」才派）。 */
  | { type: 'fanout'; fanout: FreeChatFanoutView }
  | { type: 'done'; message: FreeChatMessageView; session: FreeChatSessionView }
  | { type: 'error'; message: string }

export interface FreeChatTurnInput {
  session_id: string
  /** 发一句时必有；重新生成时不给（用最后那句用户的话）。 */
  text?: string
  images?: FreeChatImage[]
  model?: string
  /** WP370：连同 `model` 一起选的思考程度（这个模型没有这一档就按模型默认）。 */
  effort?: ReasoningEffort
  web_search?: boolean
  knowledge?: boolean
  regenerate?: boolean
  /** WP343：输入框里 `@` 选的岗位 / 职责——这句话直接交给它（不经模型挑）。 */
  target?: { position_id: string; role_id?: string; label?: string }
  /** WP350：附上的文本类资料（`data` 是 base64；服务端按扩展名读字）。 */
  files?: { name: string; data: string }[]
}

export interface FreeChatPort {
  models(actor: FreeChatActor): Promise<FreeChatModelsView>
  sessions(actor: FreeChatActor): Promise<FreeChatSessionView[]>
  create(actor: FreeChatActor, input: { title?: string }): Promise<FreeChatSessionView>
  rename(actor: FreeChatActor, id: string, title: string): Promise<FreeChatSessionView>
  remove(actor: FreeChatActor, id: string): Promise<{ deleted: boolean }>
  messages(actor: FreeChatActor, id: string): Promise<FreeChatMessageView[]>
  /** 说一轮（或重新生成最后一轮）。一帧一帧交给 `sink`；`signal` abort = 停。 */
  turn(
    actor: FreeChatActor,
    input: FreeChatTurnInput,
    sink: (frame: FreeChatFrame) => void,
    signal: AbortSignal,
  ): Promise<void>
  /** 停这条会话正在答的那一轮（客户端断开之外的兜底）。 */
  stop(actor: FreeChatActor, id: string): Promise<{ stopped: boolean }>
  /** WP343：快捷问题与 `@` 能选的岗位。可选：没装就是 `not_implemented`。 */
  assistant?(actor: FreeChatActor): Promise<AssistantStateView>
  /** WP343：助理这一层的记忆（本人的）。可选。 */
  memories?(actor: FreeChatActor): Promise<AssistantMemoryView[]>
  /** WP343：删一条助理记忆（只能删自己的；删了 AI 不再记回来）。可选。 */
  forget?(actor: FreeChatActor, id: string): Promise<{ deleted: boolean }>
  /**
   * WP350：方案卡上点了「就这样」（带人改过的几条）→ 扇出：要做的事按岗位各开一件（同一来源批次），
   * 要记的写进对应岗位 / 品牌知识库（出处 = 这份资料；WP357 决策 902 起直接生效），个人偏好进助理记忆；
   * 回方案那一条（状态已变）与汇总那一条。`dismiss` = 不用了（什么都不发）。可选。
   */
  fanout?(
    actor: FreeChatActor,
    session_id: string,
    batch_id: string,
    input: { items?: FreeChatFanoutEditInput[]; dismiss?: boolean },
  ): Promise<{ plan: FreeChatMessageView; summary?: FreeChatMessageView }>
  /**
   * WP357（决策 902）：汇总卡上「撤销」——这一批写进知识库的口径全部退役（留痕不删）。
   * 回改过的汇总那一条（带 `notes_undone_at`）。可选。
   */
  undoFanoutNotes?(
    actor: FreeChatActor,
    session_id: string,
    batch_id: string,
  ): Promise<{ summary: FreeChatMessageView }>
  /**
   * WP357（决策 902）：改一条助理记进知识库的口径（只认 `assistant_note`、只认让助理记的那个人）。
   * 就地改正文（id 与出处不变，改之前那句留痕在 `structured.previous`），回改过的那条。可选。
   */
  editNote?(actor: FreeChatActor, card_id: string, statement: string): Promise<FactCard>
  /** WP357：删一条助理记进知识库的口径（退役留痕，不真删）。可选。 */
  removeNote?(actor: FreeChatActor, card_id: string): Promise<{ retired: boolean }>
  /** WP352：助理那一条长对话（没有就建；老的多条会话第一次按时间拼进来）。可选。 */
  thread?(actor: FreeChatActor): Promise<AssistantThreadView>
  /** WP352：换个话题——这一段收起来（后台出小结），下一句开新的一段。可选。 */
  newTopic?(actor: FreeChatActor): Promise<AssistantThreadView>
  /** WP352：搜以前聊过的（小结与原话），只读。可选。 */
  searchHistory?(
    actor: FreeChatActor,
    query: { q: string; since?: string; until?: string },
  ): Promise<AssistantHistoryHitView[]>
  /** WP511（决策 1546）：以前某一段的原话（一页，只读）。可选。 */
  segment?(
    actor: FreeChatActor,
    segment_id: string,
    page: { from?: number; limit?: number },
  ): Promise<AssistantSegmentPageView>
}

/** 与「问 AI」同一档：能读自己的队列就能用——随便聊只给本人看，不碰任何对外的东西。 */
const AUTHZ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const
const TAG = 'free-chat'

/** 一张图最多 5MB（base64 约 6.7M 字符），一次最多 4 张。 */
const MAX_IMAGE_CHARS = 7_000_000
const Image = z.object({
  mime: z.string().regex(/^image\/(png|jpeg|webp|gif)$/),
  data: z.string().min(1).max(MAX_IMAGE_CHARS),
})
const TurnOptions = {
  model: z.string().min(1).max(300).optional(),
  effort: z.enum(REASONING_EFFORTS as [ReasoningEffort, ...ReasoningEffort[]]).optional(),
  web_search: z.boolean().optional(),
  knowledge: z.boolean().optional(),
}
/**
 * WP350：一份资料最多 5MB（base64 约 6.7M 字符），一次最多 3 份。
 * WP357：岗位页与事项 / 线程输入框附的资料同一个形状（`AttachedFileBody`）。
 */
export const AttachedFileBody = z.object({
  name: z.string().trim().min(1).max(200),
  data: z.string().min(1).max(MAX_IMAGE_CHARS),
})
/**
 * WP504（决策 1775 A）：第三栏点 ✦「问 AI」引用的一张卡——**结构化摘要**（是什么、叫什么、一排「字段：值」），
 * 不是截图。宿主把它像附件那样记在那句话上、围起来交给模型。
 */
export const ContextRefBody = z.object({
  kind: z.string().trim().min(1).max(40),
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  facts: z.array(z.object({ k: z.string().trim().min(1).max(60), v: z.string().max(500) })).max(40),
})
const FileBody = AttachedFileBody
/** WP357：改一条助理记的口径。 */
const NoteBody = z.object({ statement: z.string().min(1).max(300) })
const FanoutBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(20),
        drop: z.boolean().optional(),
        position_id: z.string().min(1).max(200).optional(),
        role_id: z.string().min(1).max(200).optional(),
        brand: z.boolean().optional(),
        text: z.string().max(600).optional(),
      }),
    )
    .max(60)
    .optional(),
  dismiss: z.boolean().optional(),
})
const SendBody = z.object({
  text: z.string().max(20_000),
  images: z.array(Image).max(4).optional(),
  /** WP350：附上的文本类资料（.txt / .md / .docx / .pdf；WP357 加 .xlsx / .csv）。 */
  files: z.array(FileBody).max(3).optional(),
  ...TurnOptions,
  /** WP343：`@` 选的岗位 / 职责（直接派给它）。 */
  target: z
    .object({
      position_id: z.string().min(1).max(200),
      role_id: z.string().min(1).max(200).optional(),
      label: z.string().min(1).max(120).optional(),
    })
    .optional(),
})
const RegenerateBody = z.object(TurnOptions)
const CreateBody = z.object({ title: z.string().max(80).optional() })
const RenameBody = z.object({ title: z.string().trim().min(1).max(80) })

const ID = [{ name: 'id', in: 'path' as const, required: true, description: '会话 id' }]

function portOf(deps: GatewayDeps): FreeChatPort {
  const port = deps.freeChat
  if (port === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配随便聊（GatewayDeps.freeChat）')
  return port
}

function actorOf(c: Parameters<Route['handler']>[0]): FreeChatActor {
  const p = principalOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignmentOf(c).id,
  }
}

/**
 * 一轮回答的 SSE。宿主一帧一帧往里写；客户端断开 → `cancel` → abort（宿主把已经答出来的那部分
 * 存成"停了"的一条）。宿主跑完（不论成败）流就关。
 */
function turnStream(
  port: FreeChatPort,
  actor: FreeChatActor,
  input: FreeChatTurnInput,
  trace_id: string,
): Response {
  const encoder = new TextEncoder()
  const controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>({
    start(out) {
      let closed = false
      const write = (frame: FreeChatFrame): void => {
        if (closed) return
        try {
          out.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        } catch {
          // 对端先走了：cancel 会 abort，宿主自己收尾
        }
      }
      void port
        .turn(actor, input, write, controller.signal)
        .catch((e: unknown) => {
          write({ type: 'error', message: e instanceof Error ? e.message : String(e) })
        })
        .finally(() => {
          closed = true
          try {
            out.close()
          } catch {
            // 已经关了
          }
        })
    },
    cancel() {
      controller.abort()
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'X-Trace-Id': trace_id,
    },
  })
}

export function freeChatRoutes(): Route[] {
  const base = { tag: TAG, auth: 'bearer' as const, assignment: true, authz: AUTHZ }
  return [
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/models',
        operationId: 'getFreeChatModels',
        summary:
          '随便聊能选哪些模型（所有已配好的来源，含 Agents 工坊云）、默认哪个、联网搜索与公司资料能不能用',
        returns: 'FreeChatModelsView',
      },
      async (c, deps) => ok(c, await portOf(deps).models(actorOf(c))),
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/assistant',
        operationId: 'getAssistantState',
        summary:
          '「我的助理」（WP343）：输入框下面的快捷问题（按状态生成，最多 4 个）与 `@` 能选的岗位 / 职责（本人的）',
        returns: 'AssistantStateView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.assistant === undefined)
          throw new ApiError('not_implemented', '这个服务进程的随便聊没有装「助理」')
        return ok(c, await port.assistant(actorOf(c)))
      },
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/memory',
        operationId: 'listAssistantMemory',
        summary: '「我的助理」这一层的记忆（WP343；本人的，AI 记的标出来）',
        returns: 'AssistantMemoryView[]',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.memories === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「助理」没有记忆')
        return ok(c, await port.memories(actorOf(c)))
      },
    ),
    route(
      {
        ...base,
        method: 'delete',
        path: '/v1/free-chat/memory/:id',
        operationId: 'forgetAssistantMemory',
        summary: '删一条「我的助理」记忆（只能删自己的；删了 AI 不再记回来，除非你又明说）',
        params: [{ name: 'id', in: 'path' as const, required: true, description: '记忆 id' }],
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.forget === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「助理」没有记忆')
        return ok(c, await port.forget(actorOf(c), param(c, 'id')))
      },
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/thread',
        operationId: 'getAssistantThread',
        summary:
          '「助理」那一条长对话（WP352）：会话与各段话题（一行小结、为什么切的）；老的多条会话第一次按时间拼进来',
        returns: 'AssistantThreadView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.thread === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「助理」没有长对话')
        return ok(c, await port.thread(actorOf(c)))
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/thread/topic',
        operationId: 'newAssistantTopic',
        summary: '「助理」换个话题（WP352）：这一段收起来、后台出小结，下一句开新的一段',
        returns: 'AssistantThreadView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.newTopic === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「助理」没有长对话')
        return ok(c, await port.newTopic(actorOf(c)))
      },
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/thread/search',
        operationId: 'searchAssistantHistory',
        summary: '在「助理」以前聊过的里面搜（WP352；小结与原话，只读，带出处）',
        params: [
          { name: 'q', in: 'query' as const, required: true, description: '关键词（空格隔开）' },
          { name: 'since', in: 'query' as const, description: '不早于（ISO8601）' },
          { name: 'until', in: 'query' as const, description: '早于（ISO8601）' },
        ],
        returns: 'AssistantHistoryHitView[]',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.searchHistory === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「助理」没有长对话')
        const q = (c.req.query('q') ?? '').trim().slice(0, 200)
        if (q === '') throw new ApiError('invalid_input', '要搜什么？')
        const since = c.req.query('since')
        const until = c.req.query('until')
        return ok(
          c,
          await port.searchHistory(actorOf(c), {
            q,
            ...(since === undefined || since === '' ? {} : { since }),
            ...(until === undefined || until === '' ? {} : { until }),
          }),
        )
      },
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/thread/segments/:id',
        operationId: 'getAssistantSegment',
        summary:
          '「助理」以前某一段的原话（WP511，决策 1546；一页，只读）：小结 / 出处点了在第三栏打开当时的原话',
        params: [
          { name: 'id', in: 'path' as const, required: true, description: '段 id' },
          { name: 'from', in: 'query' as const, description: '从第几句起（1 起）' },
          { name: 'limit', in: 'query' as const, description: '一页几句（默认 50，最多 200）' },
        ],
        returns: 'AssistantSegmentPageView',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.segment === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「助理」没有长对话')
        const num = (k: string): number | undefined => {
          const v = c.req.query(k)
          return v === undefined || !/^\d{1,5}$/u.test(v) ? undefined : Number(v)
        }
        const from = num('from')
        const limit = num('limit')
        return ok(
          c,
          await port.segment(actorOf(c), param(c, 'id'), {
            ...(from === undefined ? {} : { from }),
            ...(limit === undefined ? {} : { limit }),
          }),
        )
      },
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/sessions',
        operationId: 'listFreeChatSessions',
        summary: '我的随便聊会话（新的在前；只有本人的）',
        returns: 'FreeChatSessionView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).sessions(actorOf(c))),
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions',
        operationId: 'createFreeChatSession',
        summary: '新对话',
        body: CreateBody,
        returns: 'FreeChatSessionView',
      },
      async (c, deps) => {
        const input = await body(c, CreateBody)
        return ok(
          c,
          await portOf(deps).create(actorOf(c), {
            ...(input.title === undefined ? {} : { title: input.title }),
          }),
          201,
        )
      },
    ),
    route(
      {
        ...base,
        method: 'patch',
        path: '/v1/free-chat/sessions/:id',
        operationId: 'renameFreeChatSession',
        summary: '改会话名',
        params: ID,
        body: RenameBody,
        returns: 'FreeChatSessionView',
      },
      async (c, deps) => {
        const input = await body(c, RenameBody)
        return ok(c, await portOf(deps).rename(actorOf(c), param(c, 'id'), input.title))
      },
    ),
    route(
      {
        ...base,
        method: 'delete',
        path: '/v1/free-chat/sessions/:id',
        operationId: 'deleteFreeChatSession',
        summary: '删掉一条会话（连同里面的话）',
        params: ID,
        returns: '{ deleted: boolean }',
      },
      async (c, deps) => ok(c, await portOf(deps).remove(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        ...base,
        method: 'get',
        path: '/v1/free-chat/sessions/:id/messages',
        operationId: 'listFreeChatMessages',
        summary: '这条会话里的话（按时间）',
        params: ID,
        returns: 'FreeChatMessageView[]',
      },
      async (c, deps) => ok(c, await portOf(deps).messages(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions/:id/messages',
        operationId: 'sendFreeChatMessage',
        summary: '说一句（SSE 流式回：start / delta / searching / sources / done / error）',
        params: ID,
        body: SendBody,
        returns: 'text/event-stream',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, SendBody)
        if (
          input.text.trim() === '' &&
          (input.images ?? []).length === 0 &&
          (input.files ?? []).length === 0
        )
          throw new ApiError('invalid_input', '说点什么，或者贴一张图')
        const { target, ...rest } = input
        return turnStream(
          portOf(deps),
          actor,
          {
            session_id: param(c, 'id'),
            ...stripUndefined(rest),
            ...(target === undefined
              ? {}
              : {
                  target: {
                    position_id: target.position_id,
                    ...(target.role_id === undefined ? {} : { role_id: target.role_id }),
                    ...(target.label === undefined ? {} : { label: target.label }),
                  },
                }),
          },
          c.get('rctx').trace_id,
        )
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions/:id/regenerate',
        operationId: 'regenerateFreeChatReply',
        summary: '重新生成最后一条回复（SSE，同上）',
        params: ID,
        body: RegenerateBody,
        returns: 'text/event-stream',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, RegenerateBody)
        return turnStream(
          portOf(deps),
          actor,
          { session_id: param(c, 'id'), regenerate: true, ...stripUndefined(input) },
          c.get('rctx').trace_id,
        )
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions/:id/fanout/:batch',
        operationId: 'confirmAssistantFanout',
        summary:
          '「我的助理」方案卡（WP350）：点「就这样」= 按（改过的）方案扇出——要做的事按岗位各开一件（同一来源批次），要记的直接生效写进岗位 / 品牌知识库（出处 = 这份资料；WP357 决策 902），个人偏好进助理记忆；`dismiss` = 不用了',
        params: [
          ...ID,
          { name: 'batch', in: 'path' as const, required: true, description: '方案卡的来源批次' },
        ],
        body: FanoutBody,
        returns: '{ plan: FreeChatMessageView; summary?: FreeChatMessageView }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.fanout === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「助理」不能拆成多份')
        const input = await body(c, FanoutBody)
        return ok(
          c,
          await port.fanout(actorOf(c), param(c, 'id'), param(c, 'batch'), {
            ...(input.items === undefined
              ? {}
              : { items: input.items.map((i) => stripUndefined(i) as FreeChatFanoutEditInput) }),
            ...(input.dismiss === undefined ? {} : { dismiss: input.dismiss }),
          }),
        )
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions/:id/fanout/:batch/undo-notes',
        operationId: 'undoAssistantFanoutNotes',
        summary:
          '「助理」汇总卡上「撤销」（WP357，决策 902）：这一批直接写进知识库的口径全部退役（留痕不删）；回改过的汇总那一条',
        params: [
          ...ID,
          { name: 'batch', in: 'path' as const, required: true, description: '方案卡的来源批次' },
        ],
        returns: '{ summary: FreeChatMessageView }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.undoFanoutNotes === undefined)
          throw new ApiError('not_implemented', '这个服务进程的「助理」撤不了要记的口径')
        return ok(c, await port.undoFanoutNotes(actorOf(c), param(c, 'id'), param(c, 'batch')))
      },
    ),
    route(
      {
        ...base,
        method: 'patch',
        path: '/v1/free-chat/notes/:id',
        operationId: 'editAssistantNote',
        summary:
          '改一条助理记进知识库的口径（WP357，决策 902；只认助理扇出的条目、只认让助理记的那个人）：就地改正文，id 与出处不变，改之前那句留痕',
        params: [{ name: 'id', in: 'path' as const, required: true, description: '事实卡 id' }],
        body: NoteBody,
        returns: 'FactCard',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.editNote === undefined)
          throw new ApiError('not_implemented', '这个服务进程改不了助理记的口径')
        const input = await body(c, NoteBody)
        return ok(c, await port.editNote(actorOf(c), param(c, 'id'), input.statement))
      },
    ),
    route(
      {
        ...base,
        method: 'delete',
        path: '/v1/free-chat/notes/:id',
        operationId: 'removeAssistantNote',
        summary: '删一条助理记进知识库的口径（WP357，决策 902）：退役留痕，不真删',
        params: [{ name: 'id', in: 'path' as const, required: true, description: '事实卡 id' }],
        returns: '{ retired: boolean }',
      },
      async (c, deps) => {
        const port = portOf(deps)
        if (port.removeNote === undefined)
          throw new ApiError('not_implemented', '这个服务进程删不了助理记的口径')
        return ok(c, await port.removeNote(actorOf(c), param(c, 'id')))
      },
    ),
    route(
      {
        ...base,
        method: 'post',
        path: '/v1/free-chat/sessions/:id/stop',
        operationId: 'stopFreeChatReply',
        summary: '停下正在答的那一轮（已经答出来的部分留着）',
        params: ID,
        returns: '{ stopped: boolean }',
      },
      async (c, deps) => ok(c, await portOf(deps).stop(actorOf(c), param(c, 'id'))),
    ),
  ]
}

/** zod 出来的可选字段是 `T | undefined`；端口的输入不收 `undefined`（exactOptionalPropertyTypes）。 */
function stripUndefined<T extends Record<string, unknown>>(
  v: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = x
  return out as { [K in keyof T]?: Exclude<T[K], undefined> }
}
