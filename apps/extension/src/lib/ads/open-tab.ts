/**
 * 找（或开）一个**看得见的**广告后台标签页来做这件活。
 *
 * 先找已经开着、在这件活白名单站点上的标签页（用户本来就登录着、开着后台）；没有就在当前窗口
 * 新开一个、并切到它（不在后台偷偷开、不开无界面浏览器）。没有 `tabs` 权限也找得到：
 * 插件有这几个站点的权限，`tabs.query` 就看得见它们的网址。
 */

import { type ActionJob, hostMatches, hostOfUrl } from '@agentsws/browser-action'
import { chromeTabDriver } from './chrome-driver'
import type { TabDriver } from './tab-page'

/** 这件活打开的第一页（新开标签页时用）。 */
export function firstUrl(job: ActionJob): string | undefined {
  for (const step of job.plan.steps) if (step.op === 'goto') return step.url
  return undefined
}

export async function openAdsTab(job: ActionJob): Promise<TabDriver | { why: string }> {
  // WP329：Reddit 的活一律新开一个标签页（用户可能正在别的 Reddit 页面上看东西，不抢他那一页）
  if (job.plan.platform === 'reddit') return openNewTab(job)
  const hosts = job.plan.allow.hosts
  const tabs = await chrome.tabs.query({})
  const mine = tabs.filter((t) => t.id !== undefined && hostMatches(hostOfUrl(t.url ?? ''), hosts))
  const pick = mine.find((t) => t.active) ?? mine[0]
  if (pick?.id !== undefined) {
    await chrome.tabs.update(pick.id, { active: true })
    return chromeTabDriver(pick.id)
  }
  return openNewTab(job)
}

async function openNewTab(job: ActionJob): Promise<TabDriver | { why: string }> {
  const url = firstUrl(job)
  if (url === undefined) return { why: '这件活没写从哪一页开始。' }
  const made = await chrome.tabs.create({ url, active: true })
  if (made.id === undefined) return { why: '没能打开要操作的那个标签页。' }
  return chromeTabDriver(made.id)
}
