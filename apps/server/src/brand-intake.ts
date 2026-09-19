/**
 * 跑那一轮网址分析，并把确认下来的结果写出去（70 §3，WP121）。
 *
 * 抓取与解析在 `@agentsws/brand-intake`（纯函数 + 一个注入的抓取口）；
 * 这里只管三件事：**排队、记进度、确认之后往哪儿写**。
 *
 * ## 为什么 run 只在内存里
 *
 * 一次分析是**临时的**：它活到用户点「看着没问题」为止。真正要留下来的东西
 * 在那一刻就写进了工作区档案与知识库——那两处有各自的库、各自的备份、各自的
 * 权限。再为 run 单开一张表，等于给一个活不过半小时的东西做持久化，还得配一套
 * 清理策略。
 *
 * 代价说清楚：**服务重启会丢掉还没确认的那一次**，用户要重跑一遍。这个代价
 * 是可以接受的（分析几十秒、而且能重跑），而"多一张表 + 一套 GC"是永久成本。
 *
 * ## 为什么是真的后台跑
 *
 * `start` **不等**分析跑完就返回（70 §3.5：用户可以先去第 ③ 步选岗位，回来
 * 再看结果）。所以这里握着那个 promise 但不 await 它，让它自己去更新 run 上的
 * 状态；`get` 每次读到的就是当下的进度。
 *
 * 这意味着 `analyzeBrand` 抛出来的东西**没有人接**——所以它被包在一个
 * `.catch()` 里，把失败写成 run 上的一句人话。一个没人接的 rejection 会把
 * 整个进程带走，那比分析失败严重得多。
 */

import type { BrandIntakeActor, BrandIntakePort } from '@agentsws/api'
import {
  analyzeBrand,
  applyEdits,
  classifyUrl,
  estimateCredits,
  mergeProfile,
  type PageFetch,
} from '@agentsws/brand-intake'
import type {
  BrandIntakeProfile,
  BrandIntakeRun,
  BrandIntakeSourceKind,
  Clock,
} from '@agentsws/contracts'
import { DEFAULT_BRAND_INTAKE_CAP_CREDITS } from '@agentsws/contracts'

/**
 * 确认那一刻往外写的两个口。
 *
 * 分成两个而不是一个：档案那一边是**覆盖**（工作区只有一份档案），知识那一边是
 * **追加**（每次确认都可能多出几条政策要点）。合成一个口的话，调用方迟早会在
 * 其中一边做错事。
 */
export interface BrandIntakeSinks {
  /** 写组织 / 工作区档案（品牌名、平台、币种…）。 */
  applyProfile(profile: BrandIntakeProfile): Promise<void> | void
  /**
   * 往知识库里建首批条目（政策要点、商品卡），**标来源「自动分析，待核」**。
   *
   * 不给就是这个进程不装知识库——档案照写，知识那一步跳过。
   */
  seedKnowledge?: (profile: BrandIntakeProfile) => Promise<void> | void
}

export interface BrandIntakeOptions {
  clock: Clock
  workspace_id: string
  /** 抓取口。生产传 `globalThis.fetch`，测试传夹具。 */
  fetch: PageFetch
  newId: (prefix: string) => string
  sinks: BrandIntakeSinks
  /** 后台那一跳炸了的时候写哪儿（默认 stderr）。 */
  warn?: (line: string) => void
}

export interface BrandIntakeAssembly {
  port: BrandIntakePort
  /**
   * 最近那一轮抓回来的 HTML 原文（WP122 加）。
   *
   * 设计规范抽取（71 §2 第一条）要在**同一次抓取**上再读一遍 CSS。没有这一口
   * 的话它只能把用户的站再抓一遍——别人的服务器不该为我们内部的模块边界
   * 挨第二轮请求。
   *
   * 与 run 同一条命：进程重启就没了。那时候设计规范那一侧会自己去抓一轮
   * （它知道这一格可能是空的）。
   */
  latestDocuments(workspace_id: string): { url: string; kind: string; html: string }[]
  /**
   * 等当前所有在跑的分析结束。**只给测试用**——生产里没有人需要等它，
   * 界面是轮询 `get` 的。
   */
  settle(): Promise<void>
}

export function createBrandIntake(options: BrandIntakeOptions): BrandIntakeAssembly {
  const runs = new Map<string, BrandIntakeRun>()
  /** 工作区 → 最近那一轮抓回来的 HTML（见 `BrandIntakeAssembly.latestDocuments`）。 */
  const documents = new Map<string, { url: string; kind: string; html: string }[]>()
  const inflight = new Set<Promise<void>>()
  const warn = options.warn ?? ((line: string) => process.stderr.write(line))

  const now = (): string => options.clock.now()

  const inputsOf = (urls: string[]): { url: string; kind: BrandIntakeSourceKind }[] =>
    urls.map((url) => ({ url, kind: classifyUrl(url) }))

  /** 这一次是这个工作区的吗。不是就当**不存在**——不泄露"有这么个 id"。 */
  const mine = (actor: BrandIntakeActor, run_id: string): BrandIntakeRun => {
    const run = runs.get(run_id)
    if (run === undefined || run.workspace_id !== actor.workspace_id)
      throw Object.assign(new Error('没有这一次分析'), { code: 'not_found' })
    return run
  }

  /**
   * 真正跑的那一跳。**不抛**：它是一个没人 await 的 promise，抛出去会把进程带走。
   *
   * `previous` 有值就是「重新分析」——合并时用户改过的格子整格不动（70 §3.4）。
   */
  const run = (id: string, urls: string[], cap: number, previous?: BrandIntakeProfile): void => {
    const task = (async () => {
      try {
        const out = await analyzeBrand(options.fetch, urls, { capCredits: cap, keepHtml: true })
        const current = runs.get(id)
        if (current === undefined) return
        const profile = previous === undefined ? out.profile : mergeProfile(previous, out.profile)
        const gotSomething = out.pages.some((p) => p.ok)
        documents.set(current.workspace_id, out.documents ?? [])
        runs.set(id, {
          ...current,
          status: gotSomething
            ? out.stopped_for_budget
              ? 'budget_exceeded'
              : 'awaiting_confirm'
            : 'failed',
          pages: out.pages,
          budget: out.budget,
          profile,
          updated_at: now(),
          ...(gotSomething
            ? {}
            : { failure: out.pages[0]?.reason ?? '一个页面都没抓着，换个网址再试试' }),
        })
      } catch (err) {
        const current = runs.get(id)
        warn(`[brand-intake] ${id} 跑挂了：${String(err)}\n`)
        if (current !== undefined)
          runs.set(id, {
            ...current,
            status: 'failed',
            updated_at: now(),
            failure: '分析没跑完，再试一次；一直不行就先手填',
          })
      }
    })()
    inflight.add(task)
    void task.finally(() => inflight.delete(task))
  }

  const port: BrandIntakePort = {
    start(actor, input) {
      const cap = input.cap_credits ?? DEFAULT_BRAND_INTAKE_CAP_CREDITS
      const id = options.newId('bi')
      const at = now()
      const fresh: BrandIntakeRun = {
        id,
        schema_version: 1,
        workspace_id: actor.workspace_id,
        status: 'running',
        inputs: inputsOf(input.urls),
        pages: [],
        budget: {
          estimated_credits: estimateCredits(input.urls),
          cap_credits: cap,
          spent_credits: 0,
        },
        profile: {},
        created_at: at,
        updated_at: at,
      }
      runs.set(id, fresh)
      // **不等它**：用户这就可以去第 ③ 步选岗位
      run(id, input.urls, cap)
      return fresh
    },

    get(actor, run_id) {
      return mine(actor, run_id)
    },

    latest(actor) {
      let best: BrandIntakeRun | undefined
      for (const r of runs.values()) {
        if (r.workspace_id !== actor.workspace_id) continue
        if (best === undefined || r.created_at >= best.created_at) best = r
      }
      return best
    },

    async confirm(actor, input) {
      const current = mine(actor, input.run_id)
      /*
       * 先把用户改的盖进去、打上 `edited`，**再写出去**。顺序反了的话，
       * 写出去的是分析结果而不是用户确认过的那一份。
       */
      const profile =
        input.edits === undefined
          ? current.profile
          : applyEdits(current.profile, input.edits, now())
      await options.sinks.applyProfile(profile)
      await options.sinks.seedKnowledge?.(profile)
      const next: BrandIntakeRun = {
        ...current,
        status: 'confirmed',
        profile,
        updated_at: now(),
      }
      runs.set(next.id, next)
      return next
    },

    reanalyze(actor, input) {
      const current = mine(actor, input.run_id)
      const urls = input.urls ?? current.inputs.map((i) => i.url)
      const next: BrandIntakeRun = {
        ...current,
        status: 'running',
        inputs: inputsOf(urls),
        pages: [],
        budget: { ...current.budget, spent_credits: 0 },
        updated_at: now(),
      }
      runs.set(next.id, next)
      // 带着上一次的结果进去：用户改过的格子整格不动
      run(next.id, urls, next.budget.cap_credits, current.profile)
      return next
    },
  }

  return {
    port,
    latestDocuments: (workspace_id: string) => documents.get(workspace_id) ?? [],
    async settle() {
      // 一跳里可能又起了一跳（重新分析），所以转几圈
      for (let i = 0; i < 10 && inflight.size > 0; i++) await Promise.all([...inflight])
    },
  }
}
