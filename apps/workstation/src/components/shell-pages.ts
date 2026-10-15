/**
 * WP342（决策 853）：原来左栏下半那几页——现在收在左下角账号菜单的两组里，⌘K 里也照样搜得到。
 * 一份清单两处用（账号菜单、命令面板），路由一个没动（深链照旧）。
 */
import {
  BookOpen,
  Building2,
  type LucideIcon,
  MessageSquare,
  Plug,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react'

export interface ShellPage {
  to: string
  /** 词条；`mode` 为真时走 `useMode().t`（① 个人叫「岗位与品牌」那类换词） */
  key: string
  mode?: true
  icon: LucideIcon
  /** 账号菜单里归哪一组：工作内容 / 设置 */
  group: 'work' | 'settings'
  testId: string
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
  { group: 'settings', to: '/org', key: 'nav.org', mode: true, icon: Building2, testId: 'nav-org' },
  {
    group: 'settings',
    to: '/connections',
    key: 'nav.connections',
    icon: Plug,
    testId: 'nav-connections',
  },
  { group: 'settings', to: '/im-channels', key: 'nav.im', icon: MessageSquare, testId: 'nav-im' },
  {
    group: 'settings',
    to: '/settings',
    key: 'nav.settings',
    icon: Settings,
    testId: 'nav-settings',
  },
]
