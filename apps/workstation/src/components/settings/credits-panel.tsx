/**
 * 「账号与积分」下半张卡：余额、用量明细、充值（49 M5）。
 *
 * **WP59 填。** 现在它是一个空插槽：设置页已经把它摆在账号卡下面，
 * WP59 只需要替换这一个文件的内容，不必再动 `settings.tsx`——
 * 两个任务包并行跑，改同一个页面文件就一定会撞。
 */
export function CreditsPanel(): React.ReactNode {
  return null
}
