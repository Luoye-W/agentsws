/**
 * `@agentsws/stand-ins` —— 模拟回路用的全部"外部边界替身"（09 §3.1、26 §3）。
 *
 * 同一份内核代码，只把外部边界指向这里：
 * mock OpenConnector（18 §1 Connect）、stub / replay / dev-stub 运行时（17 §4）、
 * 合成人（14 决定）、合成时钟（25 §4）、收件箱投递（18 §3）、假 registry（23 §3）。
 * 替身与真实实现遵守同一契约；替身跑通不等于上线可靠（26 原则 ④）。
 */
import type { ApprovalBus, Iso8601, RuntimeAdapter, WorkspaceId } from '@agentsws/contracts'
import type { Random } from '@agentsws/kernel'
import { seededRandom } from '@agentsws/kernel'
import type { ActorSpec } from './actors.js'
import { ActorPool } from './actors.js'
import { SyntheticClock } from './clock.js'
import { MockOpenConnector } from './connect/mock-connect.js'
import type { MockState } from './connect/state.js'
import { InboxDelivery } from './delivery.js'
import { ObservationLog } from './observations.js'
import { FakeRegistry } from './registry.js'
import type { DevStubRuntime } from './runtime/dev-stub.js'
import { createDevStubRuntime } from './runtime/dev-stub.js'
import type { Recording, ReplayRuntime } from './runtime/replay.js'
import { createReplayRuntime } from './runtime/replay.js'
import type {
  CreateDraftFn,
  CreatePolicyQuestionFn,
  DraftPayload,
  StageFn,
  StageIntent,
  ToolExecutor,
} from './runtime/stub.js'
import { createStubRuntime } from './runtime/stub.js'

export * from './actors.js'
export * from './clock.js'
export * from './connect/actions.js'
export * from './connect/mock-connect.js'
export * from './connect/state.js'
export * from './delivery.js'
export * from './errors.js'
export * from './inbound.js'
export * from './observations.js'
export * from './registry.js'
export * from './runtime/dev-stub.js'
export * from './runtime/replay.js'
export * from './runtime/stub.js'
export * from './runtime/support.js'

export const DEFAULT_START: Iso8601 = '2026-09-07T01:00:00.000Z'

export interface StagedRecord {
  change_id: string
  at: Iso8601
  intent: StageIntent
}

export interface DraftRecord {
  approval_item_id: string
  at: Iso8601
  payload: DraftPayload
}

export interface StandInsOptions {
  /** 26 原则 ①：一切随机与时间来自 seed 与合成时钟。 */
  seed?: number
  /** 合成时钟起点；给了 `clock` 就以 `clock` 为准。 */
  start?: Iso8601
  clock?: SyntheticClock
  workspace_id?: WorkspaceId
  state?: MockState
  /** 合成人要用的审批总线；也可以之后 `actors.attach(bus)`。 */
  approvals?: ApprovalBus
  actors?: ActorSpec[]
  /** stub 运行时的 stage / 起草出口；不给就写进内存记录里。 */
  stage?: StageFn
  createDraft?: CreateDraftFn
  /**
   * 36 §2.2 的业务边界选择题出口（第一次遇到没答过的边界时问一次）。
   * 不给就什么都不发生——起草照常，只是少了那张卡。
   */
  createPolicyQuestion?: CreatePolicyQuestionFn
  /** stub 运行时的工具执行器；不给就走 mock OpenConnector。 */
  executeTool?: ToolExecutor
  recording?: Recording
  recordingFiles?: string[]
  returnWindowDays?: number
  signature?: string
}

export interface StandIns {
  seed: number
  clock: SyntheticClock
  random: Random
  connect: MockOpenConnector
  stubRuntime: RuntimeAdapter
  replayRuntime: ReplayRuntime
  devStub: DevStubRuntime
  actors: ActorPool
  deliveries: { workstation: InboxDelivery; email: InboxDelivery }
  registry: FakeRegistry
  observations: ObservationLog
  /** 默认 stage 出口收到的意图（没接真实账本时用）。 */
  staged: StagedRecord[]
  /** 默认起草出口收到的草稿。 */
  drafts: DraftRecord[]
}

/**
 * 默认工具执行器：把裸工具名解析成 Action，再经 mock OpenConnector 执行。
 * 两道门在这里落地：17 §6.3 不在 allowlist 的工具不到达工具；
 * 16 §3 `side_effect_policy: 'executor'` 下 write_external 一律 block。
 */
export function connectToolExecutor(connect: MockOpenConnector): ToolExecutor {
  return async ({ name, input, request }) => {
    let action_id: string
    try {
      action_id = connect.resolveActionId(name)
    } catch (e) {
      return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
    }
    if (!request.tools.allow.includes(name) && !request.tools.allow.includes(action_id)) {
      return { status: 'blocked', reason: `not_in_allowlist: ${name}` }
    }
    const meta = connect.allActions().find((a) => a.id === action_id)
    if (meta?.side_effect === 'write' && request.tools.side_effect_policy === 'executor') {
      return { status: 'blocked', reason: `write_external_requires_executor: ${action_id}` }
    }
    try {
      const res = await connect.execute(action_id, input, { token: request.tools.connect_token })
      return { status: 'ok', data: res.data }
    } catch (e) {
      return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
    }
  }
}

/** 装配一整套替身。所有替身共享同一个合成时钟；随机源按用途分流，互不干扰。 */
export function createStandIns(options: StandInsOptions = {}): StandIns {
  const seed = options.seed ?? 42
  const clock = options.clock ?? new SyntheticClock(options.start ?? DEFAULT_START)
  const random = seededRandom(seed)
  const observations = new ObservationLog()
  const connect = new MockOpenConnector({
    clock,
    random,
    observations,
    ...(options.workspace_id === undefined ? {} : { workspace_id: options.workspace_id }),
    ...(options.state === undefined ? {} : { state: options.state }),
  })

  const staged: StagedRecord[] = []
  const drafts: DraftRecord[] = []
  const stage: StageFn =
    options.stage ??
    (async (intent) => {
      const change_id = `chg_stub_${staged.length + 1}`
      staged.push({ change_id, at: clock.now(), intent })
      return { change_id }
    })
  const createDraft: CreateDraftFn =
    options.createDraft ??
    (async (payload) => {
      const approval_item_id = `appr_stub_${drafts.length + 1}`
      drafts.push({ approval_item_id, at: clock.now(), payload })
      return { approval_item_id }
    })

  const stubRuntime = createStubRuntime({
    clock,
    seed,
    stage,
    createDraft,
    executeTool: options.executeTool ?? connectToolExecutor(connect),
    ...(options.createPolicyQuestion === undefined
      ? {}
      : { createPolicyQuestion: options.createPolicyQuestion }),
    ...(options.returnWindowDays === undefined
      ? {}
      : { defaultReturnWindowDays: options.returnWindowDays }),
    ...(options.signature === undefined ? {} : { signature: options.signature }),
  })

  const replayRuntime = createReplayRuntime({
    clock,
    ...(options.recording === undefined ? {} : { recording: options.recording }),
    ...(options.recordingFiles === undefined ? {} : { files: options.recordingFiles }),
  })

  const devStub = createDevStubRuntime({ clock, seed })

  const actors = new ActorPool({
    clock,
    random: seededRandom(seed + 1),
    ...(options.approvals === undefined ? {} : { bus: options.approvals }),
  })
  for (const spec of options.actors ?? []) actors.add(spec)

  return {
    seed,
    clock,
    random,
    connect,
    stubRuntime,
    replayRuntime,
    devStub,
    actors,
    deliveries: {
      workstation: new InboxDelivery({ channel: 'workstation', clock }),
      email: new InboxDelivery({ channel: 'email', clock }),
    },
    registry: new FakeRegistry(),
    observations,
    staged,
    drafts,
  }
}
