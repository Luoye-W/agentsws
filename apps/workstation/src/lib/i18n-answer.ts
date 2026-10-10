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
  'answer.table.total': '列了 {shown} 行，共 {total} 行',
  'kind.answer': '问答',
  'matter.sys.task': '记成了任务，按「{role}」做',
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
  'answer.table.total': 'Showing {shown} of {total} rows',
  'kind.answer': 'Q&A',
  'matter.sys.task': 'Logged as a task, done as “{role}”',
}
