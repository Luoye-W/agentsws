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

import type { DomOpResult, PostedHit } from './dom.js'
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
  /** WP467：`reveal` = 等的时候先把这一个滚到眼前（只滚不点；没实现就不滚）。 */
  waitFor(selector: string, timeoutMs: number, options?: { reveal?: string }): Promise<boolean>
  /**
   * WP467：当前标签页**已经在这个 Reddit 帖子上**（`need` 给了还要它在页面上）——就地用这一页，不跳转。
   * 回 `true` = 用这一页（页面脚本已经放好）；`false` = 照常打开。没实现 = 一律照常打开。
   */
  stay?(post: string, need?: string): Promise<boolean>
  click(selector: string): Promise<DomOpResult>
  /** WP432：`highlight` = 填完把框描一圈、滚到眼前。 */
  fill(selector: string, value: string, options?: { highlight?: boolean }): Promise<DomOpResult>
  setFile(selector: string, file: SheetFile): Promise<DomOpResult>
  paste(selector: string, text: string): Promise<DomOpResult>
  text(selector: string): Promise<string>
  count(selector: string): Promise<number>
  /**
   * 截当前这个标签页（实现方保证只截广告后台那一个）。
   * WP316：`quick` = 截不到就直接回失败，不请人点插件图标授权（可选截图用）。
   */
  capture(opts?: {
    quick?: boolean
  }): Promise<{ ok: true; png_base64: string } | { ok: false; why: string }>
  /** 点导出、等下完。回文件存在哪（桌面端去读）。 */
  download(
    selector: string,
  ): Promise<{ ok: true; path: string; name: string; bytes?: number } | { ok: false; why: string }>
  /**
   * WP329：页面上正文含这段字的那几条（`await_sent` 用；页面换了 / 还在加载时回空数组，不抛）。
   * 没实现 = 这只手认不了「发出去的那一条」，`await_sent` 照实失败。
   */
  findPosted?(
    selector: string,
    body: string,
    text: string,
    /** WP432：这个号发的也算（人改了字再发）。 */
    author?: string,
  ): Promise<PostedHit[]>
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
  /** WP329：`await_sent` 默认等人点发送等多久（默认 {@link SEND_WAIT_MS}）。 */
  sendTimeoutMs?: number
  /** WP329：`await_sent` 隔多久看一眼页面（默认 2 秒；测试给 0）。 */
  sendPollMs?: number
}

/** WP329：填好草稿后等人点发送最多等多久（30 分钟，与广告「再确认」同一个数）。 */
export const SEND_WAIT_MS = 30 * 60 * 1000
const SEND_POLL_MS = 2_000
/** 等发送时每看这么多眼，问一次工坊那边点没点停、看一次有没有被拦。 */
const SEND_CHECK_EVERY = 5

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
    case 'await_sent':
      return '填好了，等你点发送'
  }
}

/** WP432：软步骤对不上时横条上那一句（不乱点，交给人粘贴）。 */
export const SOFT_MISS_LABEL = 'Reddit 的评论框没找到，可能改版了——先复制粘贴发，插件照样记'

const isSoft = (step: ActionStep): boolean =>
  (step.op === 'wait' || step.op === 'click' || step.op === 'fill') && step.soft === true

const DEFAULT_WAIT_MS = 30_000

/** 一条认出来的「发出去的那一条」的键（编号优先，没有编号用链接）。 */
const keyOf = (h: PostedHit): string => h.fullname ?? h.permalink ?? ''
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
    const wall = detectPageWall(look, plan.platform === 'reddit' ? 'Reddit' : undefined)
    if (wall !== undefined) return end('handover', wall.message)
    const zone = zoneGate(look.url, job.zones_allowed)
    if (!zone.ok) return end('handover', zone.why)
    return undefined
  }

  /**
   * WP329：「发出去的那一条」的底账——**填草稿之前**先记下页面上已经有的同样正文，
   * 这样人填完马上点发送也不会把刚发的那条当成老的。
   */
  const sendStep = plan.steps.find(
    (s): s is Extract<ActionStep, { op: 'await_sent' }> => s.op === 'await_sent',
  )
  let sentBaseline: Set<string> | undefined
  const takeBaseline = async (): Promise<Set<string>> =>
    sendStep === undefined || page.findPosted === undefined
      ? new Set()
      : new Set(
          (
            await page.findPosted(sendStep.selector, sendStep.body, sendStep.text, sendStep.author)
          ).map(keyOf),
        )
  /** WP432：软步骤对不上了——后面的软步骤都跳过，直接等人粘贴、点发送。 */
  let softMissed = false

  for (const [index, step] of plan.steps.entries()) {
    at = index + 1
    if (hooks.stopped()) return end('stopped', '你点了停止，已停下。')
    if (softMissed && isSoft(step)) continue
    const remote = await hooks.progress({
      step: at,
      of,
      label: softMissed && step.op === 'await_sent' ? SOFT_MISS_LABEL : stepLabel(step),
    })
    if (remote.stop || hooks.stopped()) return end('stopped', '你点了停止，已停下。')

    const allowed = checkStep(step, plan.allow, plan.kind)
    if (!allowed.ok) return end('failed', allowed.why)

    // 动手之前再看一眼当前页（页面可能自己跳走了）
    if (WRITE_OPS.includes(step.op)) {
      const stop = await pageCheck()
      if (stop !== undefined) return stop
    }

    try {
      if (step.op === 'fill' && sendStep !== undefined && sentBaseline === undefined)
        sentBaseline = await takeBaseline()
      const out = await doStep(step)
      if (out !== undefined) {
        // WP432：软步骤对不上（不是停 / 被拦 / 跳走）——不乱点、不停，记一笔，去等人自己粘贴
        if (isSoft(step) && out.outcome === 'handover' && !hooks.stopped()) {
          const stop = await pageCheck()
          if (stop !== undefined) return stop
          softMissed = true
          reads.fill_missed = '1'
          continue
        }
        return out
      }
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
        // WP467：用户已经开着这个帖子（插件挑的就是那个标签页）——不跳转，就地填
        if (step.post !== undefined && page.stay !== undefined) {
          if (await page.stay(step.post, step.need)) return pageCheck()
        }
        await page.goto(step.url)
        return pageCheck()
      }
      case 'click':
        // WP467：框已经展开着（用户先点过）就不再点
        if (step.unless !== undefined && (await page.count(step.unless)) > 0) return undefined
        return fromDom(await page.click(step.selector))
      case 'fill':
        return fromDom(
          await page.fill(
            step.selector,
            step.value,
            step.highlight === true ? { highlight: true } : undefined,
          ),
        )
      case 'wait': {
        const limit = step.timeout_ms ?? hooks.waitTimeoutMs ?? DEFAULT_WAIT_MS
        const ok =
          step.reveal === undefined
            ? await page.waitFor(step.selector, limit)
            : await page.waitFor(step.selector, limit, { reveal: step.reveal })
        if (ok || step.optional === true) return stoppedMeanwhile()
        const halted = stoppedMeanwhile()
        if (halted !== undefined) return halted
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
        const shot = await page.capture(step.optional === true ? { quick: true } : undefined)
        if (!shot.ok && step.optional === true) {
          // WP316（决策 600 C）：截不到也往下做，记一笔「没截到」，账本用前后导出作证
          const missing = (reads.evidence_missing ?? '').split(',').filter((x) => x !== '')
          if (!missing.includes(step.tag)) missing.push(step.tag)
          reads.evidence_missing = missing.join(',')
          return undefined
        }
        if (!shot.ok) return stoppedMeanwhile() ?? end('handover', shot.why)
        await hooks.evidence(step.tag, shot.png_base64, await page.url())
        return undefined
      }
      case 'download': {
        const got = await page.download(step.selector)
        if (!got.ok) return stoppedMeanwhile() ?? end('handover', got.why)
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
      case 'await_sent':
        return awaitSent(step)
    }
  }

  /**
   * WP329：等人自己点发送。先记下页面上**已经有**的同样正文（不把老的那条认成刚发的），
   * 然后隔一会儿看一眼，出现一条新的就读回它的编号与链接。插件在这一步什么都不点。
   */
  async function awaitSent(
    step: Extract<ActionStep, { op: 'await_sent' }>,
  ): Promise<ActionResult | undefined> {
    if (page.findPosted === undefined)
      return end('failed', '这只「手」认不了发出去的那一条，没法读回，已停下。')
    const seen = sentBaseline ?? (await takeBaseline())
    const limit = step.timeout_ms ?? hooks.sendTimeoutMs ?? SEND_WAIT_MS
    const pollMs = hooks.sendPollMs ?? SEND_POLL_MS
    for (let looks = 1, waited = 0; ; looks += 1, waited += pollMs) {
      if (hooks.stopped()) return end('stopped', '你点了停止，已停下。草稿留在页面上，没发。')
      const hit = (await page.findPosted(step.selector, step.body, step.text, step.author)).find(
        (h) => !seen.has(keyOf(h)),
      )
      if (hit !== undefined) {
        if (hit.fullname !== undefined) reads.fullname = hit.fullname
        if (hit.permalink !== undefined) reads.permalink = hit.permalink
        // WP432：真发出去的字（人可能改过）——记进发出记录、改了多少进学习回路
        if (hit.text !== undefined && hit.text !== '') reads.sent_text = hit.text.slice(0, 10_000)
        return undefined
      }
      if (looks % SEND_CHECK_EVERY === 0) {
        const remote = await hooks.progress({ step: at, of, label: stepLabel(step) })
        if (remote.stop || hooks.stopped())
          return end('stopped', '你点了停止，已停下。草稿留在页面上，没发。')
        const stop = await pageCheck()
        if (stop !== undefined) return stop
      }
      if (waited >= limit)
        return (
          (await pageCheck()) ??
          end(
            'handover',
            `等了 ${limit >= 60_000 ? `${Math.round(limit / 60_000)} 分钟` : `${Math.round(limit / 1000)} 秒`}没看到发出去的那一条（没点发送，或者被拦了）。已停下；这一条不算发出。`,
          )
        )
      await hooks.sleep(pollMs)
    }
  }

  function fromDom(out: DomOpResult): ActionResult | undefined {
    return out.ok ? undefined : end('handover', out.why)
  }

  /** 等的时候（等页面 / 等授权截图 / 等下载）用户点了停止：算「停了」，不算「交给人」。 */
  function stoppedMeanwhile(): ActionResult | undefined {
    return hooks.stopped() ? end('stopped', '你点了停止，已停下。') : undefined
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
