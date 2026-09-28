/**
 * WP180：设置 →「官方插件」在服务进程这一侧——**出卡、批了才做、做完记事件**；配置写回只许写不在锁定表里的行。
 *
 * 规矩与"怎么做"在 `@agentsws/dsh-adapter/official-plugins`（审过的清单、插件层、做完锁定 patch 逐字节比一遍）；
 * 这里只管三件运行时不该知道的事：
 *
 * | 事 | 这里怎么做 |
 * |---|---|
 * | 点装 / 升级 / 卸载 | 先按清单查一遍（清单外 / 版本没审过 → 直接拒、记 `official_plugin.rejected`），过了出一张 `official_plugin` 卡 |
 * | 卡批了 | 按卡上的动作与包名**再查一遍**（卡发出去之后清单 / 安装可能变了），照做；做完记 `official_plugin.changed`，被拒记 `official_plugin.rejected` |
 * | 运行中保存配置 | 锁定表里的行一律拒、记 `profile.config_rejected`（只带字段名不带值）；别的行写进插件层自己的 patch |
 *
 * **一台机器一份**（与电脑操控同一条理由：插件跟着这台电脑上的 dsh 走，与卖哪个品牌无关）；插件层在数据目录下
 * `official-plugins/`。没有数据目录（全内存档）、或读不到审过的清单 → 整页"装不了"（fail closed）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ApprovalItem,
  Clock,
  DecideInput,
  EventEnvelope,
  OfficialPluginAction,
  OfficialPluginCardPayload,
  OfficialPluginSpec,
  OfficialPluginsView,
  ProfileConfigWrite,
  ProfileConfigWriteResult,
} from '@agentsws/contracts'
import {
  applyChange,
  cardPayload,
  defaultAllowlistPath,
  defaultProfilePatchPath,
  layerPatchPath,
  lockedRowIds,
  type OfficialPluginBackend,
  OfficialPluginError,
  planChange,
  pluginView,
  readPluginAllowlist,
  shippedBundleBackend,
  writeLayerConfig,
} from '@agentsws/dsh-adapter/official-plugins'

type AppendEvent = (e: Omit<EventEnvelope, 'id' | 'at'>) => void

interface ApprovalsLike {
  create(input: never): Promise<ApprovalItem>
}

export interface OfficialPluginsOptions {
  /** 插件层目录（数据目录下 `official-plugins/`）；不给 = 装不了。 */
  dir?: string
  /** 审过的清单；缺省是仓库里那一份。 */
  allowlistPath?: string
  /** 锁定 patch；缺省是仓库里那一份。装插件时它要逐字节不变。 */
  profilePatchPath?: string
  appendEvent: AppendEvent
  clock: Clock
  /** 测试注入（缺省用官方模块建的插件层）。 */
  backend?: OfficialPluginBackend
}

export interface OfficialPluginsActor {
  workspace_id: string
  person_id: string
}

export interface OfficialPluginsAssembly {
  view(): Promise<OfficialPluginsView>
  /** 点了装 / 升级 / 卸载：查过清单就出一张卡（被拒抛 {@link OfficialPluginError}）。 */
  request(
    actor: OfficialPluginsActor,
    input: { action: OfficialPluginAction; name: string },
    approvals: ApprovalsLike,
  ): Promise<OfficialPluginsView>
  /** 审批总线的包装：`official_plugin` 卡批了 → 再查一遍 → 照做。 */
  wrap<B extends { decide(id: string, by: never, input: DecideInput): Promise<ApprovalItem> }>(
    bus: B,
  ): B
  /** 运行中保存配置：锁定表里的行一律拒。 */
  saveConfig(
    actor: OfficialPluginsActor,
    write: ProfileConfigWrite,
  ): Promise<ProfileConfigWriteResult>
}

const OWNER_ROLE = 'common.owner'

export function createOfficialPlugins(options: OfficialPluginsOptions): OfficialPluginsAssembly {
  const patchPath = options.profilePatchPath ?? defaultProfilePatchPath()
  /** 卡批之前"有一张卡在等"：包名 → 动作与卡 id（重启丢了也不要紧，批卡看的是卡上的 payload）。 */
  const pending = new Map<string, { action: OfficialPluginAction; approval_item_id: string }>()
  let backendP: Promise<OfficialPluginBackend> | undefined

  const allowlist = (): OfficialPluginSpec[] =>
    readPluginAllowlist(options.allowlistPath ?? defaultAllowlistPath())

  /** 装不了的原因（人话）；能装回 `undefined`。 */
  const blocked = (): string | undefined => {
    if (options.dir === undefined && options.backend === undefined) {
      return '这个服务进程没有数据目录，装不了插件'
    }
    try {
      allowlist()
      return undefined
    } catch (e) {
      return `读不到审过的插件清单（${e instanceof Error ? e.message : String(e)}），先不装`
    }
  }

  const backend = (): Promise<OfficialPluginBackend> => {
    if (options.backend !== undefined) return Promise.resolve(options.backend)
    backendP ??= shippedBundleBackend({ dir: options.dir as string })
    return backendP
  }

  const emit = (
    actor: OfficialPluginsActor,
    type: 'official_plugin.changed' | 'official_plugin.rejected' | 'profile.config_rejected',
    payload: Record<string, unknown>,
  ): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id: actor.workspace_id as EventEnvelope['workspace_id'],
      type,
      actor: { kind: 'person', id: actor.person_id },
      correlation: { trace_id: `trc_official_plugin_${options.clock.now()}` },
      payload,
    })
  }

  const reject = (
    actor: OfficialPluginsActor,
    input: { action: OfficialPluginAction; name: string },
    e: unknown,
  ): never => {
    const code = e instanceof OfficialPluginError ? e.code : 'load_failed'
    const message = e instanceof Error ? e.message : String(e)
    emit(actor, 'official_plugin.rejected', { ...input, reason: code, message })
    throw e instanceof OfficialPluginError ? e : new OfficialPluginError('load_failed', message)
  }

  async function view(): Promise<OfficialPluginsView> {
    const why = blocked()
    if (why !== undefined) return { plugins: [], blocked_reason: why }
    const b = await backend()
    return {
      plugins: allowlist().map((spec) => {
        const v = pluginView(spec, b)
        const p = pending.get(spec.name)
        return p === undefined ? v : { ...v, state: 'pending' as const, pending: p }
      }),
    }
  }

  const TITLE: Record<OfficialPluginAction, string> = {
    install: '装',
    upgrade: '升级',
    uninstall: '卸载',
  }

  function summaryOf(p: OfficialPluginCardPayload): string {
    const version =
      p.from_version === undefined ? `版本 ${p.version}` : `从 ${p.from_version} 升到 ${p.version}`
    const tools =
      p.tools.length === 0 ? '不给 AI 加工具' : `给 AI 加这些工具：${p.tools.join('、')}`
    const net = p.network ? `会出网：${p.network_note ?? ''}` : '不出网'
    const source =
      p.source === 'shipped' ? 'DeepSeek 官方（dsh 自带的可选包）' : 'DeepSeek 官方（npm）'
    return `${p.name}，${version}，来源：${source}，许可证 ${p.license}。${tools}；${net}。`
  }

  async function request(
    actor: OfficialPluginsActor,
    input: { action: OfficialPluginAction; name: string },
    approvals: ApprovalsLike,
  ): Promise<OfficialPluginsView> {
    const why = blocked()
    if (why !== undefined) reject(actor, input, new OfficialPluginError('not_allowlisted', why))
    const b = await backend()
    let plan: ReturnType<typeof planChange>
    try {
      plan = planChange({ ...input, allowlist: allowlist(), backend: b })
    } catch (e) {
      return reject(actor, input, e)
    }
    const payload = cardPayload(plan)
    const item = await approvals.create({
      workspace_id: actor.workspace_id,
      schema_version: 1,
      kind: 'official_plugin',
      role_id: OWNER_ROLE,
      subject: { object: { type: 'official_plugin', id: plan.spec.name } },
      dedupe_key: `official_plugin:${plan.action}:${plan.spec.name}:${plan.version}`,
      title: `${TITLE[plan.action]}官方插件「${plan.spec.title}」？`,
      summary: summaryOf(payload),
      payload,
      evidence: {
        source_events: [],
        provenance: { seen: [{ type: 'official_plugin', id: plan.spec.name }] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'person', id: actor.person_id },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: actor.person_id, via: 'role_holder' }],
        rule: 'owner',
        escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      risk_class: 'high',
    } as never)
    pending.set(plan.spec.name, { action: plan.action, approval_item_id: item.id })
    return view()
  }

  /** 卡批了：按卡上的动作与包名再查一遍、照做、记事件。失败只记事件，不让批卡那一下报错。 */
  async function onApproved(item: ApprovalItem): Promise<void> {
    const card = item.payload as Partial<OfficialPluginCardPayload> | undefined
    const actor = {
      workspace_id: item.workspace_id,
      person_id: item.decision?.by ?? item.proposer.id,
    }
    if (card?.action === undefined || card.name === undefined) return
    const input = { action: card.action, name: card.name }
    try {
      if (blocked() !== undefined) throw new OfficialPluginError('not_allowlisted', blocked() ?? '')
      const b = await backend()
      const plan = planChange({ ...input, allowlist: allowlist(), backend: b })
      // 批的是哪个版本就只装哪个版本：卡发出去之后清单换了版本，要重新出卡
      if (plan.version !== card.version) {
        throw new OfficialPluginError(
          'unreviewed_version',
          `卡上是 ${card.version}，现在清单里是 ${plan.version}，请重新点一次`,
        )
      }
      await applyChange({ plan, backend: b, protectedFiles: [patchPath] })
      emit(actor, 'official_plugin.changed', {
        ...input,
        version: plan.version,
        approval_item_id: item.id,
      })
    } catch (e) {
      try {
        reject(actor, input, e)
      } catch {
        // 已记 `official_plugin.rejected`
      }
    }
  }

  function wrap<
    B extends { decide(id: string, by: never, input: DecideInput): Promise<ApprovalItem> },
  >(bus: B): B {
    return new Proxy(bus, {
      get(target, prop, receiver) {
        if (prop !== 'decide') {
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async (id: string, by: never, input: DecideInput): Promise<ApprovalItem> => {
          const out = await target.decide(id, by, input)
          if (out.kind !== 'official_plugin') return out
          const name = (out.payload as { name?: string } | undefined)?.name
          const approved = out.state === 'approved' || out.state === 'approved_edited'
          const settled = approved || out.state === 'rejected' || out.state === 'withdrawn'
          if (settled && name !== undefined && pending.get(name)?.approval_item_id === id) {
            pending.delete(name)
          }
          if (approved) await onApproved(out)
          return out
        }
      },
    })
  }

  async function saveConfig(
    actor: OfficialPluginsActor,
    write: ProfileConfigWrite,
  ): Promise<ProfileConfigWriteResult> {
    const why = blocked()
    if (why !== undefined || options.dir === undefined) {
      return {
        ok: false,
        row_id: write.row_id,
        reason: 'unknown_row',
        message: why ?? '没有插件层',
      }
    }
    const b = await backend()
    const out = writeLayerConfig({
      layerPatch: layerPatchPath(b.dir),
      write,
      locked: lockedRowIds(readFileSync(patchPath, 'utf8')),
    })
    if (!out.ok) {
      const fields =
        write.config !== null && typeof write.config === 'object' ? Object.keys(write.config) : []
      emit(actor, 'profile.config_rejected', {
        row_id: out.row_id,
        reason: out.reason,
        fields,
        message: out.message,
      })
    }
    return out
  }

  return { view, request, wrap, saveConfig }
}

/** 插件层目录：数据目录下 `official-plugins/`。 */
export function officialPluginsDirIn(dataDir: string): string {
  return join(dataDir, 'official-plugins')
}
