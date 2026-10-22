/**
 * WP361（决策 925）：「进行中」看板做成一页——账号菜单「工作内容」里和会议 / 知识库 / 技能并列，⌘K 搜得到。
 *
 * 原来是「岗位与品牌 / 团队 / 公司」页的一个 tab（40 §3.3），WP356 收进了设置弹窗；它是工作内容、不是设置，
 * 这里挪回成页面。看板本身还是原来那个件（按主人分列、自己取数）。老地址 `/org?tab=inprogress` 跳到这里。
 */
import { InprogressTab } from '@/components/org/inprogress-tab'
import { PageHeader } from '@/components/design/kit'
import { useApp } from '@/lib/app-context'

export function InProgressPage(): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="flex max-w-5xl flex-col gap-4" data-testid="inprogress-page">
      <PageHeader title={t('org.tab.inprogress')} sub={t('sp.inprogress.desc')} />
      <InprogressTab />
    </div>
  )
}
