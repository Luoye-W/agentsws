/**
 * WP291（决策 356）：岗位页当场回答的词条（中英各一份）。界面少字：回答区不加标题、不加说明段。
 */
export const ANSWER_ZH: Record<string, string> = {
  'answer.continue': '接着聊',
  'answer.as_task': '当成任务做',
  'answer.close': '关掉',
  'answer.basis': '依据',
  'answer.retry': '重试',
  'answer.failed': '没跑成：{why}',
  'answer.stopped': '被停下了',
  'answer.pending': '正在查',
  'kind.answer': '问答',
  'matter.sys.task': '记成了任务，按「{role}」做',
  // WP341（决策 847）：对话里的按钮 / 表单 / 媒体 / 链接
  'genui.secret.tip': '值直接存进本机加密库，不经 AI',
  'genui.secret.elsewhere': '去连接',
  'genui.media.open': '点开看 · {host}',
  'genui.link.open': '打开 {host}',
  'genui.tool.running': '正在做：{label}',
  'genui.tool.staged': '出了 {n} 张卡，批了才做',
  'genui.tool.failed': '没做成：{why}',
  'genui.media.always': '以后这个网站的图都直接显示',
  'settings.image_hosts': '直接显示图片的网站',
  'settings.image_hosts.hint':
    'AI 回话里别的网站的图默认要点一下才加载（免得不点就让对方知道你在看）。这里的网站和已连的店铺直接显示。',
  'settings.image_hosts.shop': '已连的店铺',
  'settings.image_hosts.add': '加',
  'settings.image_hosts.placeholder': '例如 images.example.com',
  'settings.image_hosts.remove': '删掉 {host}',
}

export const ANSWER_EN: Record<string, string> = {
  'answer.continue': 'Keep talking',
  'answer.as_task': 'Do it as a task',
  'answer.close': 'Close',
  'answer.basis': 'Based on',
  'answer.retry': 'Retry',
  'answer.failed': "Didn't run: {why}",
  'answer.stopped': 'Stopped',
  'answer.pending': 'Looking it up',
  'kind.answer': 'Q&A',
  'matter.sys.task': 'Logged as a task, done as “{role}”',
  'genui.secret.tip': 'Saved straight to the local vault, never seen by the AI',
  'genui.secret.elsewhere': 'Connect',
  'genui.media.open': 'Open · {host}',
  'genui.link.open': 'Open {host}',
  'genui.tool.running': 'Working on: {label}',
  'genui.tool.staged': '{n} card(s) to approve first',
  'genui.tool.failed': "Didn't work: {why}",
  'genui.media.always': 'Always show images from this site',
  'settings.image_hosts': 'Sites whose images show directly',
  'settings.image_hosts.hint':
    'Images from other sites in AI replies load only when you click, so they can’t tell you’re reading. These sites and your connected stores load directly.',
  'settings.image_hosts.shop': 'Connected store',
  'settings.image_hosts.add': 'Add',
  'settings.image_hosts.placeholder': 'e.g. images.example.com',
  'settings.image_hosts.remove': 'Remove {host}',
}
