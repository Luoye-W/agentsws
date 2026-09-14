/**
 * 从历史邮件学一遍（48 §4 #9 之二；24 学习回路的一个新入口）。
 *
 * 这个包的老纪律照旧：**只放判定与编排，不认识模型、不认识审批总线、不认识 HTTP**。
 * 聚类与出题的纯函数在 `@agentsws/support-core`；模型那一下由调用方给一个
 * {@link HistorySummarizer}（走运行时 / 网关，22 的预算与留痕在那一层）；
 * 产出是一串**候选**，由宿主变成 `knowledge_update` 卡。
 *
 * 一条边界要说清楚：**原始材料区的内容永不直接进模型**（18 §2.1）。这里收的
 * `QaPair` 是管线清洗过的正文（`clean_text`），不是 raw MIME；而且例子进 prompt
 * 之前还要过一次围栏（`historyPrompt` 里做的）。历史邮件里躺着的注入串，
 * 跟今天刚收到的那一封一样有效。
 */
import type { Iso8601 } from '@agentsws/contracts'
import type {
  HistoryCluster,
  HistoryPrompt,
  HistorySummary,
  KnowledgeCandidate,
  QaPair,
} from '@agentsws/support-core'
import { clusterHistory, historyCandidate, historyPrompt } from '@agentsws/support-core'

export type { HistoryCluster, HistoryPrompt, HistorySummary, QaPair }

/** 模型那一下。返回 `undefined` = 这一簇归纳不出东西，跳过（不是错误）。 */
export type HistorySummarizer = (prompt: HistoryPrompt) => Promise<HistorySummary | undefined>

export interface LearnFromHistoryInput {
  /** 管线清洗过的「客户问 → 真人答」。 */
  pairs: readonly QaPair[]
  summarize: HistorySummarizer
  at: Iso8601
  minClusterSize?: number
  maxClusters?: number
}

export interface LearnFromHistoryResult {
  clusters: HistoryCluster[]
  candidates: KnowledgeCandidate[]
  /** 归纳不出东西的簇（给运营看"为什么只学到 3 条"）。 */
  skipped: { category: string; reason: 'no_summary' | 'not_a_candidate' }[]
}

/**
 * 学一遍。
 *
 * 顺序是**先聚类再出题**，不是先让模型读全部邮件：一次归纳只看一簇的 6 个例子，
 * 于是成本与簇数成正比而不是与邮件数成正比，而且人审时看得见"这条是从哪 12 封来的"。
 */
export async function learnFromHistory(
  input: LearnFromHistoryInput,
): Promise<LearnFromHistoryResult> {
  const clusters = clusterHistory(input.pairs, {
    ...(input.minClusterSize === undefined ? {} : { minClusterSize: input.minClusterSize }),
    ...(input.maxClusters === undefined ? {} : { maxClusters: input.maxClusters }),
  })
  const candidates: KnowledgeCandidate[] = []
  const skipped: LearnFromHistoryResult['skipped'] = []
  for (const cluster of clusters) {
    const summary = await input.summarize(historyPrompt(cluster))
    if (summary === undefined) {
      skipped.push({ category: cluster.category, reason: 'no_summary' })
      continue
    }
    const candidate = historyCandidate(cluster, summary, input.at)
    if (candidate === undefined) {
      skipped.push({ category: cluster.category, reason: 'not_a_candidate' })
      continue
    }
    candidates.push(candidate)
  }
  return { clusters, candidates, skipped }
}
