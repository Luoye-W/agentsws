/**
 * 知识包（`kefu-knowledge-pack/v1`）导入的**落库**那一步（48 §4 #9）。
 *
 * 解析、字段对照、承诺类判定全在 `packages/knowledge`（纯函数，零 IO）；这里只做
 * 三件带副作用的事：解 zip、逐条提议、该激活的激活。
 *
 * 两条纪律：
 * - **承诺类（定价 / 政策 / 边界）一律落候选**。包是别人的 AI 生成的，
 *   里面的"退款 30 天"错了一个字，我们的 Agent 会逐字念给客户听；
 * - 其余条目也只有 front matter 明写了 `confidence: high` **且**带了核实日期才自动
 *   激活——没写核实日期就是没人核实过，不是"今天核实的"。
 *
 * 这也是 D 期迁移工具的地基：把旧 SaaS 的知识导出成这个格式，走的就是这条路。
 */
import { Buffer } from 'node:buffer'
import type { GatewayActor } from '@agentsws/api'
import type { Clock, FactCard } from '@agentsws/contracts'
import {
  canActivatePackEntry,
  type Knowledge,
  packEntryToCard,
  parseKnowledgePack,
  unzipFiles,
} from '@agentsws/knowledge'

export interface ImportPackInput {
  zip?: Uint8Array
  files?: readonly { path: string; content: string }[]
}

export interface ImportPackResult {
  imported: number
  activated: number
  proposed: number
  warnings: string[]
  manifest: { name: string; version: string }
}

export class KnowledgePackError extends Error {
  readonly code = 'invalid_input'
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgePackError'
  }
}

export async function importKnowledgePack(
  knowledge: Knowledge,
  actor: GatewayActor,
  input: ImportPackInput,
  opts: { clock: Clock },
): Promise<ImportPackResult> {
  const files =
    input.zip !== undefined ? unzipFiles(Buffer.from(input.zip)) : [...(input.files ?? [])]
  const parsed = parseKnowledgePack(files)
  if (!parsed.ok) throw new KnowledgePackError(`${parsed.code}：${parsed.message}`)

  const ctx = {
    workspace_id: actor.workspace_id,
    owner: actor.person_id,
    scope: [],
    created_by_id: actor.assignment_id,
    at: opts.clock.now(),
  }

  let activated = 0
  let proposed = 0
  const cards: FactCard[] = []
  for (const entry of parsed.entries) {
    const card = await knowledge.store.propose(packEntryToCard(entry, ctx))
    cards.push(card)
    if (canActivatePackEntry(entry)) {
      // `by_agent` 那道闸还在：承诺类就算 front matter 吹成 high 也进不来
      await knowledge.store.activate(card.id, actor.person_id, { by_agent: true })
      activated += 1
    } else {
      proposed += 1
    }
  }

  return {
    imported: cards.length,
    activated,
    proposed,
    warnings: parsed.warnings,
    manifest: { name: parsed.manifest.name, version: parsed.manifest.version },
  }
}
