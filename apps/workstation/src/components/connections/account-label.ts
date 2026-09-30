import type { ConnectionView } from '@/lib/api'

/**
 * WP210（Luoye 09-30）：已连上的卡，**大标题是账号本身**（邮箱地址、店名、主页名…）——
 * 「任意邮箱（IMAP / SMTP）」这种类型名对用户没意义，降成小字副标题。
 *
 * 顺序：身份展示名（服务端试连时拿到的，邮箱地址 / 店名）→ 账号 id → 用户起的别名 →
 * 实在什么都没有才退回类型名。全是「给人看的身份」，凭据不在这个对象里。
 */
export function accountLabel(
  c: Pick<ConnectionView, 'identity' | 'alias' | 'service_label'>,
): string {
  const pick = [c.identity?.display_name, c.identity?.account_id, c.alias].find(
    (x): x is string => x !== undefined && x.trim() !== '',
  )
  return pick ?? c.service_label
}
