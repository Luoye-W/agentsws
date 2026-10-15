/**
 * WP316：广告改动（上传表卡、改动记录、再确认）的词条（中英各一份）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-reddit-write.ts`）。
 * 界面少字：按钮一个词，说明进问号（`*.hint`）。
 */
export const ADS_CHANGES_ZH: Record<string, string> = {
  'adsc.sheet.download': '原表',
  'adsc.sheet.download.hint':
    '批了之后，Chrome 里的「Agents 工坊助手」在你自己的后台里上传这一份；平台先给预览，你再确认一次才提交。新建的一律先暂停。',
  'adsc.sheet.more': '还有 {n} 条',
  'adsc.sheet.warnings': '{n} 条提醒',
  'adsc.title': '广告改动',
  'adsc.empty': '还没有',
  'adsc.confirm': '确认提交',
  'adsc.reject': '不提交',
  'adsc.confirm.hint':
    '平台预览截图在下面。确认了插件才点「应用 / 发布」；不提交就停下，后台里没应用。',
  'adsc.undo': '撤销',
  'adsc.undo.hint':
    '出一张撤销卡（要你点）：Google 上传用后台的一次性撤销，暂停 / 改预算反着点，Meta 用改前表反向导入。',
  'adsc.undo.staged': '撤销卡出好了，去卡片流里批。',
  'adsc.readback.ok': '读回对上',
  'adsc.readback.bad': '读回对不上',
  'adsc.missing': '没截到',
  'adsc.missing.hint': '止损要先停住，截不到图也照做；用停之前、停之后两份导出作证。',
  'adsc.kept': '存到 {date}',
  'adsc.state.queued': '排队',
  'adsc.state.running': '在做',
  'adsc.state.waiting_confirm': '等你确认',
  'adsc.state.done': '做完',
  'adsc.state.failed': '没做成',
  'adsc.state.rejected': '退回',
  'adsc.state.handover': '交给你',
  'adsc.state.stopped': '停了',
  'adsc.state.expired': '作废',
  'adsc.tag.before': '前',
  'adsc.tag.preview': '预览',
  'adsc.tag.after': '后',
  'adsc.stop_loss': '止损',
}

export const ADS_CHANGES_EN: Record<string, string> = {
  'adsc.sheet.download': 'Sheet',
  'adsc.sheet.download.hint':
    'Once approved, the Agents Workshop helper in your Chrome uploads this file in your own ad account. The platform shows a preview and you confirm once more before it is applied. Anything new starts paused.',
  'adsc.sheet.more': '{n} more',
  'adsc.sheet.warnings': '{n} notes',
  'adsc.title': 'Ad changes',
  'adsc.empty': 'None yet',
  'adsc.confirm': 'Submit',
  'adsc.reject': "Don't submit",
  'adsc.confirm.hint':
    'The platform preview is below. The helper clicks Apply / Publish only after you submit; otherwise it stops and nothing is applied.',
  'adsc.undo': 'Undo',
  'adsc.undo.hint':
    'Creates an undo card for you to approve: Google uploads use the built-in one-time undo, pauses / budgets are reversed, Meta re-imports the before-sheet.',
  'adsc.undo.staged': 'Undo card created — approve it in your cards.',
  'adsc.readback.ok': 'Read-back OK',
  'adsc.readback.bad': 'Read-back mismatch',
  'adsc.missing': 'No screenshot',
  'adsc.missing.hint':
    'Stop-loss pauses first even without screenshots; the before / after exports are kept as evidence.',
  'adsc.kept': 'Kept until {date}',
  'adsc.state.queued': 'Queued',
  'adsc.state.running': 'Running',
  'adsc.state.waiting_confirm': 'Needs you',
  'adsc.state.done': 'Done',
  'adsc.state.failed': 'Failed',
  'adsc.state.rejected': 'Sent back',
  'adsc.state.handover': 'Over to you',
  'adsc.state.stopped': 'Stopped',
  'adsc.state.expired': 'Expired',
  'adsc.tag.before': 'Before',
  'adsc.tag.preview': 'Preview',
  'adsc.tag.after': 'After',
  'adsc.stop_loss': 'Stop-loss',
}
