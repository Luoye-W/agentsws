/**
 * WP261：独立站运营（一个品牌一份）——把查询（`shop-ops.ts`）、出卡（`shop-propose.ts`）、批后执行（`shop-apply.ts`）
 * 接到店铺授权（`shop-auth.ts`）与变更账本上。
 *
 * - `read` / `propose` 只拿 {@link ShopAdminAssembly.reader}（只能查）；
 * - `apply` 只认 `after.via === 'shop_admin'` 的卡，拿 {@link ShopAdminAssembly.admin}（能改）——
 *   服务端 `backendApply` 那一条是它唯一的调用方；
 * - 同一张卡执行过就记下（`shop-ops.json`），重放直接回上一次的结果，不在店里建第二份。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RunRequest, StagedChange } from '@agentsws/contracts'
import type { BackendResult, StageInput } from '@agentsws/txn'
import { SHOP_ADMIN_TEXT, ShopAdminError } from './shop-admin.js'
import { type Applied, applyShopChange, ShopApplyError } from './shop-apply.js'
import type { ShopAdminAssembly } from './shop-auth.js'
import {
  actionFor,
  fromCard,
  mandateOf,
  ReadLog,
  roleHasTool,
  runRead,
  SHOP_VIA,
  type ShopOps,
  type ShopOpsOptions,
  toCard,
} from './shop-ops.js'
import { draftOf } from './shop-propose.js'

interface AppliedRecord {
  at: string
  ref: { type: string; id: string }
  verified: boolean
  note?: string
}

export function createShopOps(
  options: Omit<ShopOpsOptions, 'access' | 'reader' | 'admin'> & { auth: ShopAdminAssembly },
): ShopOps {
  const ws = options.workspace_id
  const log = new ReadLog()
  const now = (): string => options.clock.now()
  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      options.appendEvent?.(type, { workspace_id: ws, ...payload })
    } catch {
      // 记事件失败不影响结果
    }
  }
  let applied: Record<string, AppliedRecord> = {}
  const loadApplied = (): Record<string, AppliedRecord> => {
    const f = options.stateFile
    if (f !== undefined && existsSync(f))
      try {
        applied =
          (JSON.parse(readFileSync(f, 'utf8')) as { applied?: Record<string, AppliedRecord> })
            .applied ?? {}
      } catch {
        // 坏文件当没执行过
      }
    return applied
  }
  const saveApplied = (id: string, rec: AppliedRecord): void => {
    const all = { ...loadApplied(), [id]: rec }
    // 只留最近 500 张
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete all[k]
    applied = all
    const f = options.stateFile
    if (f === undefined) return
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, `${JSON.stringify({ version: 1, applied: all }, null, 2)}\n`)
  }

  const contextFor = async () => {
    const access = await options.auth.access()
    if (access === undefined) {
      // 现问一次让它抛出带人话的那一类（没授权 / 过期 / 被收回）
      await options.auth.reader()
      throw new ShopAdminError('not_authorized', SHOP_ADMIN_TEXT.not_authorized)
    }
    return { access, reader: await options.auth.reader() }
  }

  return {
    async read(tool, input, request) {
      const { access, reader } = await contextFor()
      return runRead({ reader, access, log }, tool, input, request.id)
    },

    async propose(tool, input, request: RunRequest) {
      const role_id = request.actor.role_id
      const action = actionFor(role_id, tool, input)
      if (action === undefined || !roleHasTool(role_id, tool))
        return { status: 'blocked', message: '这条职责不能做这件事。' }
      const m = mandateOf(() => options.effectiveConfig(request.actor.assignment_id), action)
      if (m === undefined) return { status: 'blocked', message: '这条职责没有这个动作，出不了卡。' }
      const { access, reader } = await contextFor()
      const draft = await draftOf(
        tool,
        {
          reader,
          access,
          log,
          run_id: request.id,
          fileRoots: options.fileRoots(),
          ...(options.assetFile === undefined
            ? {}
            : { assetFile: (id: string) => options.assetFile?.(id) }),
        },
        input,
      )
      const kind = action.replace(/^stage_/, '') as StageInput['kind']
      const recipient = (await options.recipient?.({
        route_to: m.route_to,
        role_id,
        person_id: request.actor.person_id,
      })) ?? {
        person: request.actor.person_id,
        via: m.route_to === 'role_holder' ? 'role_holder' : 'owner',
      }
      const run_id = request.id
      const outcome = await options.ledger.stage({
        workspace_id: ws as never,
        role_id,
        assignment_id: request.actor.assignment_id,
        run_id,
        change_set_id: `cs_${run_id}_${draft.op}_${draft.target.id}`.slice(0, 200),
        kind,
        target: draft.target,
        ...(draft.field === undefined ? {} : { field: draft.field }),
        // 卡面只给人看人话那几格；给执行器的那几格改名成 `_` 开头（见 `toCard`）
        before: toCard(draft.before),
        after: toCard(draft.after),
        notes: draft.notes,
        created_by: { kind: 'agent', id: `agent_${role_id}` },
        mandate: m.mandate,
        /*
         * 决策 175：改店一律先出卡、**人批了**才改——不管职责 yml 给这条动作开到了 L2（额内自动）。
         * 第 1 步先全按 L1 走；以后要不要按 yml 放开由 Luoye 定（见 WP261 报告）。
         */
        level: 'L1',
        provenance: {
          run_id,
          seen: { [draft.target.type]: [draft.target.id] },
          // 改前必读：这次运行真读过（或新建的东西没有原文可读）才写进去——guardrail 按它拦
          read_full:
            draft.synthetic === true || log.has(run_id, draft.target)
              ? [`${draft.target.type}:${draft.target.id}`]
              : [],
          recorded_at: now(),
        },
        approval: {
          title: draft.title,
          summary: draft.notes.join('\n'),
          recipients: [{ person: recipient.person as never, via: recipient.via }],
          proposer: {
            kind: 'agent',
            id: `agent_${role_id}`,
            assignment_id: request.actor.assignment_id,
          },
          rule: recipient.via,
          separation_of_duties: false,
          source_events: [],
        },
      } as StageInput)
      if (!outcome.ok) return { status: 'blocked', message: outcome.message }
      emit('shop_ops.staged', { op: draft.op, kind, change_id: outcome.change.id })
      return {
        status: 'staged',
        message: `出了一张卡：${draft.title}。你批了才改店里。`,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    async apply(change: StagedChange): Promise<BackendResult | undefined> {
      const after = fromCard(change.after)
      if (after.via !== SHOP_VIA || change.workspace_id !== ws) return undefined
      const done = loadApplied()[change.id]
      if (done !== undefined)
        return {
          status: done.verified ? 'ok' : 'unknown',
          execution_id: `shop_${change.id}`,
          outcome_ref: done.ref,
        }
      let admin: Awaited<ReturnType<ShopAdminAssembly['admin']>>
      let access: NonNullable<Awaited<ReturnType<ShopAdminAssembly['access']>>>
      try {
        admin = await options.auth.admin()
        const a = await options.auth.access()
        if (a === undefined)
          throw new ShopAdminError('not_authorized', SHOP_ADMIN_TEXT.not_authorized)
        access = a
      } catch (e) {
        return {
          status: 'failed',
          error: { message: e instanceof Error ? e.message : String(e), retryable: true },
        }
      }
      if (typeof after.store === 'string' && after.store !== admin.store)
        return {
          status: 'failed',
          error: {
            message: `卡上是 ${after.store}，现在授权的是 ${admin.store}，没改`,
            retryable: false,
          },
        }
      let result: Applied
      try {
        result = await applyShopChange(
          { admin, access, fileRoots: options.fileRoots(), fetch: options.fetch ?? fetch, now },
          { ...change, after, before: fromCard(change.before) },
        )
      } catch (e) {
        const retryable =
          e instanceof ShopApplyError
            ? e.retryable
            : e instanceof ShopAdminError && (e.code === 'network' || e.code === 'timeout')
        emit('shop_ops.apply_failed', {
          op: after.shop_op,
          change_id: change.id,
          code: e instanceof ShopAdminError ? e.code : 'apply',
        })
        return {
          status: 'failed',
          error: { message: e instanceof Error ? e.message : String(e), retryable },
        }
      }
      saveApplied(change.id, {
        at: now(),
        ref: result.ref,
        verified: result.verified,
        ...(result.note === undefined ? {} : { note: result.note }),
      })
      emit('shop_ops.applied', {
        op: after.shop_op,
        change_id: change.id,
        verified: result.verified,
      })
      return result.verified
        ? { status: 'ok', execution_id: `shop_${change.id}`, outcome_ref: result.ref }
        : {
            status: 'unknown',
            execution_id: `shop_${change.id}`,
            outcome_ref: result.ref,
            error: {
              message: `改了，但读回来没对上（${result.note ?? '去后台看一眼'}）`,
              retryable: false,
            },
          }
    },
  }
}
