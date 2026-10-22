/**
 * 插件这一侧跑一件活（WP313）：拿表 → 在看得见的广告后台标签页上走步骤表 → 回报进度、截图、下载、结局。
 *
 * 判断全在公共执行模块的 `runAction` 里（白名单、指纹、不碰的区域、被拦就停、读回自证）；
 * 这里只把它接到本机服务与横条上：
 * - **停**：横条上的「停止」（{@link RunControl.stop}）或工作台点了停（进度回执里带回来），下一步之前停；
 * - **再确认一次**：横条上出「确认提交 / 不提交」，工坊卡上点了确认也算（进度回执里带回来）；
 *   30 分钟没人理就停下交给人；
 * - **截图 / 下载交不上去就停**：留不下证据的改动不做（决策 556）。
 */

import {
  type ActionJob,
  type ActionResult,
  base64ToBytes,
  type ConfirmAnswer,
  runAction,
} from '@agentsws/browser-action'
import {
  actionDownload,
  actionEvidence,
  actionProgress,
  actionResult,
  actionSheet,
  type LocalClientOptions,
} from '../local-client'
import type { BannerState } from './dom-messages'
import { type TabDriver, TabPage } from './tab-page'

/** 横条上点了什么（background 收到页面脚本的消息就改它）。 */
export interface RunControl {
  stop: boolean
  answer?: 'yes' | 'no' | undefined
}

export interface ExecutorDeps {
  client: LocalClientOptions
  driver: TabDriver
  control: RunControl
  now(): string
  sleep(ms: number): Promise<void>
  /** 等人确认最多等多久（默认 30 分钟）。 */
  confirmTimeoutMs?: number
  /** 两步之间（默认公共模块的固定间隔；测试给 0）。 */
  gapMs?: number
}

export const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000
const CONFIRM_POLL_MS = 2_000

export async function executeJob(job: ActionJob, deps: ExecutorDeps): Promise<ActionResult> {
  // WP445：Reddit 这条路插件只填草稿、发送由人点——横条用中性的那一种
  const assist = job.plan.platform === 'reddit' ? { assist: true } : {}
  let banner: BannerState | null = {
    title: job.title,
    step: 0,
    of: job.plan.steps.length,
    label: '准备',
    ...assist,
  }
  const page = new TabPage({
    driver: deps.driver,
    platform: job.plan.platform,
    hosts: job.plan.allow.hosts,
    bannerState: () => banner,
    stopped: () => deps.control.stop,
  })
  const setBanner = async (next: BannerState | null): Promise<void> => {
    banner = next
    await deps.driver.banner(next)
  }

  const result = await runAction(job, page, {
    sheet: async () => {
      const got = await actionSheet(deps.client, job.id)
      if (!got.ok) return undefined
      return { name: got.data.name, mime: got.data.mime, bytes: base64ToBytes(got.data.base64) }
    },
    progress: async (p) => {
      await setBanner({ title: job.title, step: p.step, of: p.of, label: p.label, ...assist })
      const said = await actionProgress(deps.client, job.id, {
        step: p.step,
        of: p.of,
        label: p.label,
        ...(p.waiting_confirm === true ? { waiting_confirm: true } : {}),
      })
      // 本机服务一时连不上不算「停」：卡已经批过了，横条上的停止照样管用
      return { stop: said.ok && said.data.stop }
    },
    stopped: () => deps.control.stop,
    confirm: async (prompt): Promise<ConfirmAnswer> => {
      deps.control.answer = undefined
      const base = banner ?? { title: job.title, step: 0, of: job.plan.steps.length, label: '' }
      await setBanner({ ...base, label: '等你确认', confirm: prompt })
      const limit = deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS
      try {
        for (let waited = 0; waited < limit; waited += CONFIRM_POLL_MS) {
          if (deps.control.stop) return 'stop'
          if (deps.control.answer !== undefined) return deps.control.answer
          const said = await actionProgress(deps.client, job.id, {
            step: base.step,
            of: base.of,
            label: '等你确认',
            waiting_confirm: true,
          })
          if (said.ok && said.data.stop) return 'stop'
          if (said.ok && said.data.confirmed) return 'yes'
          await deps.sleep(CONFIRM_POLL_MS)
        }
        return 'timeout'
      } finally {
        await setBanner({ ...base, label: '等你确认' })
      }
    },
    evidence: async (tag, png_base64, url) => {
      const sent = await actionEvidence(deps.client, job.id, {
        tag,
        png_base64,
        url,
        taken_at: deps.now(),
      })
      if (!sent.ok) throw new Error(`截图没交上去（${sent.message}），留不下证据就不往下做`)
    },
    downloaded: async (tag, file) => {
      const sent = await actionDownload(deps.client, job.id, { tag, ...file })
      if (!sent.ok) throw new Error(`导出的文件没登记上（${sent.message}）`)
    },
    sleep: deps.sleep,
    ...(deps.gapMs === undefined ? {} : { gapMs: deps.gapMs }),
  })

  await setBanner(null)
  // 结局交三次；都交不上就算了——本机服务那边 45 分钟没音讯会记「断了」并告诉人
  for (let i = 0; i < 3; i += 1) {
    const sent = await actionResult(deps.client, job.id, result)
    if (sent.ok || sent.kind !== 'offline') break
    await deps.sleep(5_000)
  }
  return result
}
