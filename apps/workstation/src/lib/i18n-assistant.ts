/**
 * WP343（决策 334 / 859）：「我的助理」这一页的字（中英各一份）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-handoff.ts`）。界面少字：
 * 空状态一个标题 + 一行小字；别的都是按钮上的几个字。
 */
export const ASSISTANT_ZH: Record<string, string> = {
  'assistant.empty.title': '有什么要我做的？',
  'assistant.empty.sub':
    '随便聊、问什么都行；也可以直接交代事情，我交给对应的岗位去做，做完回来告诉你。',
  'assistant.placeholder': '问点什么，或交代一件事…（@ 选岗位直接交）',
  'assistant.dispatched': '已交给 {who}',
  'assistant.report.open': '去看',
  'assistant.report.decide': '去拍板',
  'assistant.mention.title': '直接交给',
  'assistant.mention.none': '还没有岗位',
  'assistant.mention.remove': '不指定了',
  'assistant.peers': '替我答同事',
  'assistant.peers.asked': '谁问过我',
  'assistant.peers.meets': '约时间',
  'assistant.peers.profile': '我的公开资料',
  'assistant.peers.ask': '问同事',
  'assistant.memory': '记忆',
  'assistant.memory.empty': '还没记什么。说「记住…」我就记下。',
  'assistant.memory.ai': 'AI 记的 · {date}',
  'assistant.memory.mine': '你说的 · {date}',
  'assistant.memory.forget': '删掉这条',
}

export const ASSISTANT_EN: Record<string, string> = {
  'assistant.empty.title': 'What can I do for you?',
  'assistant.empty.sub':
    "Chat about anything, or hand me a task — I'll pass it to the right position and report back.",
  'assistant.placeholder': 'Ask anything, or hand me a task… (@ to pick a position)',
  'assistant.dispatched': 'Handed to {who}',
  'assistant.report.open': 'Open',
  'assistant.report.decide': 'Decide',
  'assistant.mention.title': 'Hand straight to',
  'assistant.mention.none': 'No positions yet',
  'assistant.mention.remove': 'Clear',
  'assistant.peers': 'Answer colleagues for me',
  'assistant.peers.asked': 'Who asked me',
  'assistant.peers.meets': 'Meetings',
  'assistant.peers.profile': 'My public profile',
  'assistant.peers.ask': 'Ask a colleague',
  'assistant.memory': 'Memory',
  'assistant.memory.empty': 'Nothing yet. Say "remember…" and I will.',
  'assistant.memory.ai': 'Noted by AI · {date}',
  'assistant.memory.mine': 'You said · {date}',
  'assistant.memory.forget': 'Forget this',
}
