/**
 * WP343（决策 641 等的就是 333 / 334）：「我的助理」这一层的记忆，照 WP320 的那一套接上。
 *
 * - **归属**：本人的。助理是替这个人干活的那一层（个人模式里就是他自己），所以记在本人名下、
 *   只在助理对话里用；**不进岗位 / 职责的运行**（那几层有自己的记忆，WP320）。
 * - **怎么记**：与 WP320 同一套提炼与过滤（`auto-memory.ts`）——人明说「记住…」、模型回答末尾的
 *   `<remember>…</remember>`、人话里「以后 / 下次 / 一律…」那一句；一次性内容、密钥账号、敏感信息不记；
 *   一样的不记；删过的不再记回来（墓碑），除非人又明说「记住」；一轮最多 3 条。
 * - **怎么提醒**：每记一条，记忆账本记一笔（`tier: personal`、`scope_id` = 本人）——WP320 的「记住了：……」
 *   小提醒照常冒出来，点它回到「我的助理」看 / 删。
 * - 存在这个品牌的 `free-chat.sqlite` 里（和会话放一起），不进事件日志正文。
 */
import type { FreeChatActor } from '@agentsws/api'
import { jaccard } from '@agentsws/knowledge'
import {
  AUTO_MEMORY_MAX_PER_RUN,
  AUTO_MEMORY_SAME,
  AUTO_MEMORY_SIMILAR,
  memoryCandidatesOf,
  type RememberItem,
  screenMemoryText,
} from './auto-memory.js'
import type { AssistantMemoryRow, FreeChatStore } from './free-chat-store.js'

/** 系统提示里最多列几条助理记忆。 */
export const ASSISTANT_MEMORY_PROMPT_MAX = 20

const normalize = (s: string): string => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/** 给模型的那段：现有的记忆 + 记忆规矩（「自动记忆」关了就只在明说时写）。 */
export function assistantMemoryLines(rows: readonly AssistantMemoryRow[], auto: boolean): string[] {
  const lines =
    rows.length === 0
      ? []
      : [
          '你记得的关于用户的事（照着做；用户可以随时删）：',
          ...rows.slice(-ASSISTANT_MEMORY_PROMPT_MAX).map((r) => `- ${r.text}`),
        ]
  return [
    ...lines,
    auto
      ? '- 用户说了值得以后一直记住的东西（稳定的偏好、纠正过你的做法、关于他或他公司的长期事实），在回答最后单独起一行写 <remember>一句话</remember>（最多 3 行）；一次性的事、密码 / 账号 / 密钥、个人敏感信息不记；没有就不写，也不要在别处提这个标记。'
      : '- 只有用户明说「记住…」时，才在回答最后单独起一行写 <remember>要记的那句话</remember>；密码 / 账号 / 密钥、个人敏感信息不记。',
  ]
}

/**
 * 一轮答完：提炼 → 过滤 → 去重 / 墓碑 → 写。回写了哪几条（调用方记账、发提醒）。
 * 停下的、答错的不记（调用方只在正常答完时调）。
 */
export function rememberAfterTurn(input: {
  store: FreeChatStore
  actor: FreeChatActor
  user_text: string
  items: readonly RememberItem[]
  auto: boolean
  at: string
  session_id: string
  newId(prefix: string): string
}): AssistantMemoryRow[] {
  const { store, actor } = input
  const existing = store.memories(actor.person_id)
  const tombstones = store.tombstones(actor.person_id)
  const written: AssistantMemoryRow[] = []
  const candidates = memoryCandidatesOf({
    brief: input.user_text,
    items: input.items,
    auto: input.auto,
  })
  for (const c of candidates) {
    if (written.length >= AUTO_MEMORY_MAX_PER_RUN) break
    const screened = screenMemoryText(c.text, { asked: c.asked })
    if (!screened.ok) continue
    const all = [...existing, ...written]
    const same = all.some(
      (e) =>
        normalize(e.text) === normalize(screened.text) ||
        jaccard(e.text, screened.text) >= AUTO_MEMORY_SAME,
    )
    if (same) continue
    const buried = tombstones.some((t) => jaccard(t, screened.text) >= AUTO_MEMORY_SIMILAR)
    if (buried && !c.asked) continue
    const row: AssistantMemoryRow = {
      id: input.newId('amem'),
      person_id: actor.person_id,
      at: input.at,
      text: screened.text,
      written_by: 'ai',
      reason: c.reason,
      session_id: input.session_id,
    }
    store.putMemory(row)
    written.push(row)
  }
  return written
}
