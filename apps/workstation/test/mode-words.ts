/**
 * WP271（docs/95，Luoye 10-08）：① 个人模式里**不许出现的公司概念词**，以及扫一屏用的小工具。
 *
 * 扫的是人能看到的全部字：正文、输入框占位字、问号里的说明（`aria-label` / `data-hint`）、
 * 悬停提示（`title`）。① 里出现一个就红，失败信息带着是哪个词、在哪一句里。
 */
import type { OrganizationView } from '@/lib/api'

export const COMPANY_WORDS = [
  '主管',
  '老板',
  '上级',
  '成员',
  '部门',
  '范围',
  '并进来',
  '加入一家公司',
  '所有者',
  '负责人',
] as const

/** 一屏上人看得到的字（正文 + 占位字 + 问号 / 悬停里的说明）。 */
export function shownText(root: ParentNode): string {
  const attrs = [
    ...root.querySelectorAll('[placeholder],[aria-label],[data-hint],[title]'),
  ].flatMap((el) =>
    ['placeholder', 'aria-label', 'data-hint', 'title']
      .map((a) => el.getAttribute(a))
      .filter((v): v is string => v !== null && v !== ''),
  )
  return [root.textContent ?? '', ...attrs].join('\n')
}

/** 这一屏上出现了哪几个公司概念词，各带一小段上下文。 */
export function companyWordsIn(root: ParentNode): string[] {
  const text = shownText(root)
  const hits: string[] = []
  for (const word of COMPANY_WORDS) {
    const at = text.indexOf(word)
    if (at >= 0) hits.push(`${word}：…${text.slice(Math.max(0, at - 12), at + word.length + 12)}…`)
  }
  return hits
}

const T0 = '2026-10-08T09:00:00.000Z'

/** ① 个人：一个人、两个品牌（品牌数与模式无关）。 */
export const SOLO_ORG: OrganizationView = {
  id: 'org_1',
  legal_name: '诺伏特',
  discoverable: false,
  owner_id: 'per_wang',
  role: 'owner',
  brands: 2,
  members: 1,
  solo: true,
  mode: 'solo',
  created_at: T0,
}

/** ③ 公司集体：除了你还有别人，开着公司模式。 */
export const COMPANY_ORG: OrganizationView = {
  ...SOLO_ORG,
  members: 3,
  solo: false,
  mode: 'company',
}
