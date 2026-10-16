/**
 * WP342（决策 853）：原来左栏下半那几页——现在收在左下角账号菜单里，⌘K 里也照样搜得到。
 * 一份清单两处用（账号菜单、命令面板），路由一个没动（深链照旧）。
 *
 * WP356（决策 923）：「设置」那一组（岗位与品牌 / 连接 / 消息渠道 / 设置）收进设置弹窗，
 * 这里只剩「工作内容」；设置项的清单在 `settings-panel/sections.tsx`。
 *
 * WP361（决策 925）：「进行中」看板从设置弹窗挪回这里（`/in-progress`），和会议 / 知识库 / 技能并列；
 * 只在同事互联 / 公司模式出（`team`）——个人模式只有你自己，首页那块「进行中」就够了。
 */
import { BookOpen, ClipboardList, type LucideIcon, Sparkles, Users } from 'lucide-react'

export interface ShellPage {
  to: string
  key: string
  icon: LucideIcon
  /** 账号菜单里归哪一组（设置那一组 WP356 起是弹窗） */
  group: 'work'
  testId: string
  /** WP361：只在同事互联 / 公司模式出（组织读到了、不是个人）。 */
  team?: true
}

/** 现在这个用法下看得到这一页没有（账号菜单、⌘K 共用）。 */
export function shellPageVisible(p: ShellPage, m: { known: boolean; solo: boolean }): boolean {
  return p.team !== true || (m.known && !m.solo)
}

export const SHELL_PAGES: readonly ShellPage[] = [
  { group: 'work', to: '/meetings', key: 'nav.meetings', icon: Users, testId: 'nav-meetings' },
  {
    group: 'work',
    to: '/knowledge',
    key: 'nav.knowledge',
    icon: BookOpen,
    testId: 'nav-knowledge',
  },
  { group: 'work', to: '/skills', key: 'nav.skills', icon: Sparkles, testId: 'nav-skills' },
  {
    group: 'work',
    to: '/in-progress',
    key: 'org.tab.inprogress',
    icon: ClipboardList,
    testId: 'nav-inprogress',
    team: true,
  },
]
