/**
 * 执行器：在一个「页面」上把一件活的步骤表走完（逻辑在这里，手在插件的 {@link ActionPage} 实现里）。
 *
 * 顺序与 Reddit 通道的 `runWriteOn` 一样，每一步不过就停、照实说，**不重试、不换路**：
 *
 * 1. 每一步之前：用户点了停止没有；这一步在不在白名单里（{@link checkStep}）；
 *    当前页面还在白名单站点上吗、落没落进「默认不碰」的区域（{@link zoneGate}）。
 * 2. 每打开一页：跳去别的站了吗、是不是验证码 / 登录页 / 受限页（{@link detectPageWall}）→ 停，交给人。
 * 3. 上传 / 粘贴之前：拿到的这张表再算一次指纹，和审批卡上绑的对不上 → 拒。
 * 4. 平台报了阻断错误（`expect_none`）→ 退回 AI 改；人在再确认时没点头 → 也退回。
 * 5. 全部做完**读回页面自证**。自证不过 = 没做成，照实报。
 *
 * 两步之间等一个固定时长（{@link STEP_GAP_MS}）——限速，不是伪装，没有随机数。
 */

import type { DomOpResult } from './dom.js'
import { sheetMatches } from './fingerprint.js'
import { checkStep, hostMatches, hostOfUrl } from './guard.js'
import { STEP_GAP_MS } from './pace.js'
import type {
  ActionJob,
  ActionOutcome,
  ActionResult,
  ActionStep,
  DownloadTag,
  EvidenceTag,
} from './types.js'
import { detectPageWall, type PageLook } from './walls.js'
import { zoneGate } from './zones.js'

/** 插件实现的那只「手」。每个方法只做一件事，判断全在执行器里。 */
export interface ActionPage {
  url(): Promise<string>
  goto(url: string): Promise<{ finalUrl: string }>
  look(): Promise<PageLook>
  waitFor(selector: string, timeoutMs: number): Promise<boolean>
  click(selector: string): Promise<DomOpResult>
  fill(selector: string, value: string): Promise<DomOpResult>
  setFile(selector: string, file: SheetFile): Promise<DomOpResult>
  paste(selector: string, text: string): Promise<DomOpResult>
  text(selector: string): Promise<string>
  count(selector: string): Promise<number>
  /** 截当前这个标签页（实现方保证只截广告后台那一个）。 */
  capture(): Promise<{ ok: true; png_base64: string } | { ok: false; why: string }>
  /** 点导出、等下完。回文件存在哪（桌面端去读）。 */
  download(
    selector: string,
  ): Promise<{ ok: true; path: string; name: string; bytes?: number } | { ok: false; why: string }>
}

export interface SheetFile {
  name: string
  mime: string
  bytes: Uint8Array
}

export type ConfirmAnswer = 'yes' | 'no' | 'stop' | 'timeout'

export interface RunHooks {
  /** 拿审批绑定的那张表（要上传的动作才会调）。 */
  sheet?(): Promise<SheetFile | undefined>
  /** 报进度；回「要不要停」（工坊里点了停）。 */
  progress(p: {
    step: number
    of: number
    label: string
    waiting_confirm?: boolean
  }): Promise<{ stop: boolean }>
  /** 横条上点了「停止」没有（插件本地）。 */
  stopped(): boolean
  /** 停下来等人再确认一次。 */
  confirm(prompt: string): Promise<ConfirmAnswer>
  evidence(tag: EvidenceTag, png_base64: string, url: string): Promise<void>
  downloaded(tag: DownloadTag, file: { path: string; name: string; bytes?: number }): Promise<void>
  sleep(ms: number): Promise<void>
  /** 两步之间的间隔（默认 {@link STEP_GAP_MS}；测试给 0）。 */
  gapMs?: number
  /** `wait` 步骤默认等多久。 */
  waitTimeoutMs?: number
}

/** 横条上那几个字。 */
export function stepLabel(step: ActionStep): string {
  switch (step.op) {
    case 'goto':
      return '打开页面'
    case 'click':
      return '点按钮'
    case 'fill':
      return '填数'
    case 'wait':
      return '等页面'
    case 'upload':
    case 'paste':
      return '放上传表'
    case 'capture':
      return '截图'
    case 'download':
      return '导出'
    case 'read':
    case 'expect_none':
      return '核对'
    case 'confirm':
      return '等你确认'
  }
}

const DEFAULT_WAIT_MS = 30_000
const WRITE_OPS: readonly ActionStep['op'][] = ['click', 'fill', 'upload', 'paste', 'download']

export async function runAction(
  job: ActionJob,
  page: ActionPage,
  hooks: RunHooks,
): Promise<ActionResult> {
  const plan = job.plan
  const reads: Record<string, string> = {}
  const of = plan.steps.length
  let at = 0
  const end = (outcome: ActionOutcome, message: string): ActionResult => ({
    outcome,
    message,
    step: at,
    reads,
  })

  /** 打开 / 点完一页之后：还在白名单站上吗、被拦了没有、进没进不碰的区域。 */
  const pageCheck = async (): Promise<ActionResult | undefined> => {
    const look = await page.look()
    if (!hostMatches(hostOfUrl(look.url), plan.allow.hosts))
      return end(
        'handover',
        `页面跳去了白名单外的站（${hostOfUrl(look.url) || look.url}），已停下。`,
      )
    const wall = detectPageWall(look)
    if (wall !== undefined) return end('handover', wall.message)
    const zone = zoneGate(look.url, job.zones_allowed)
    if (!zone.ok) return end('handover', zone.why)
    return undefined
  }

  for (const [index, step] of plan.steps.entries()) {
    at = index + 1
    if (hooks.stopped()) return end('stopped', '你点了停止，已停下。')
    const remote = await hooks.progress({ step: at, of, label: stepLabel(step) })
    if (remote.stop || hooks.stopped()) return end('stopped', '你点了停止，已停下。')

    const allowed = checkStep(step, plan.allow, plan.kind)
    if (!allowed.ok) return end('failed', allowed.why)

    // 动手之前再看一眼当前页（页面可能自己跳走了）
    if (WRITE_OPS.includes(step.op)) {
      const stop = await pageCheck()
      if (stop !== undefined) return stop
    }

    try {
      const out = await doStep(step)
      if (out !== undefined) return out
    } catch (err) {
      return end(
        'failed',
        `浏览器这一步没做成：${err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)}`,
      )
    }

    if (index < of - 1) await hooks.sleep(hooks.gapMs ?? STEP_GAP_MS)
  }

  // 做完先看一眼：弹了验证码 / 被拦就停
  const after = await pageCheck()
  if (after !== undefined) return after
  return verify()

  async function doStep(step: ActionStep): Promise<ActionResult | undefined> {
    switch (step.op) {
      case 'goto': {
        await page.goto(step.url)
        return pageCheck()
      }
      case 'click':
        return fromDom(await page.click(step.selector))
      case 'fill':
        return fromDom(await page.fill(step.selector, step.value))
      case 'wait': {
        const ok = await page.waitFor(
          step.selector,
          step.timeout_ms ?? hooks.waitTimeoutMs ?? DEFAULT_WAIT_MS,
        )
        if (ok) return undefined
        const stop = await pageCheck()
        return (
          stop ??
          end('handover', '等不到该出现的东西（可能页面改版了，或者后台还在转）。已停下交给你。')
        )
      }
      case 'upload':
      case 'paste': {
        const file = await sheetChecked()
        if ('outcome' in file) return file
        if (step.op === 'upload') return fromDom(await page.setFile(step.selector, file))
        return fromDom(await page.paste(step.selector, new TextDecoder().decode(file.bytes)))
      }
      case 'capture': {
        const shot = await page.capture()
        if (!shot.ok) return end('handover', shot.why)
        await hooks.evidence(step.tag, shot.png_base64, await page.url())
        return undefined
      }
      case 'download': {
        const got = await page.download(step.selector)
        if (!got.ok) return end('handover', got.why)
        await hooks.downloaded(step.tag, {
          path: got.path,
          name: got.name,
          ...(got.bytes === undefined ? {} : { bytes: got.bytes }),
        })
        return undefined
      }
      case 'read':
        reads[step.key] = (await page.text(step.selector)).slice(0, 500)
        return undefined
      case 'expect_none': {
        const n = await page.count(step.selector)
        if (n === 0) return undefined
        const said = (await page.text(step.selector)).slice(0, 300)
        if (said !== '') reads.platform_errors = said
        return end('rejected', `${step.why}（${n} 处）`)
      }
      case 'confirm': {
        await hooks.progress({ step: at, of, label: stepLabel(step), waiting_confirm: true })
        const answer = await hooks.confirm(step.prompt)
        if (answer === 'yes') {
          await hooks.progress({ step: at, of, label: stepLabel(step) })
          return undefined
        }
        if (answer === 'stop') return end('stopped', '你点了停止，已停下。')
        if (answer === 'no') return end('rejected', '你没有确认提交，退回去改。')
        return end('handover', '等你确认等太久了，已停下。平台预览还在后台里，回头可以自己看。')
      }
    }
  }

  function fromDom(out: DomOpResult): ActionResult | undefined {
    return out.ok ? undefined : end('handover', out.why)
  }

  async function sheetChecked(): Promise<SheetFile | ActionResult> {
    if (job.sheet === undefined || hooks.sheet === undefined)
      return end('failed', '这一步要上传表，但这件活没带表。')
    const file = await hooks.sheet()
    if (file === undefined) return end('failed', '没拿到上传表。')
    if (!(await sheetMatches(file.bytes, job.sheet.fingerprint)))
      return end('failed', '上传表和审批时的不一样（被改过），已拒绝上传。')
    return file
  }

  async function verify(): Promise<ActionResult> {
    const v = plan.verify
    if (v.op === 'none') return end('done', '做完了。')
    if (v.url !== undefined) {
      await page.goto(v.url)
      const stop = await pageCheck()
      if (stop !== undefined) return stop
    }
    if (v.op === 'absent')
      return (await page.count(v.selector)) === 0
        ? end('done', '做完了，读回对上了。')
        : end('failed', '点过了，但刷新之后页面上还是老样子——没做成。')
    const hit =
      v.text === undefined
        ? (await page.count(v.selector)) > 0
        : (await page.text(v.selector)).includes(v.text)
    return hit
      ? end('done', '做完了，读回对上了。')
      : end('failed', '点过了，但读回页面没看到该有的结果——没做成。')
  }
}
