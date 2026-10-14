/**
 * WP324（决策 690，Luoye 10-14）：**连接卡 / 配置卡**的服务端那一半——出卡、去重、补完接着做。
 *
 * 一件任务跑到一半发现要先连上什么（`not_connected` / 缺凭据 / 建站工具没装没登 / 管店没授权）或先设好什么
 * （还不知道是哪家店、公司地址没填…），运行时在这一轮收尾时调 {@link SetupCardsAssembly.onRunBlocked}：
 *
 * - 缺连接 → 一张 `connect_request`：要连哪几样、为什么、（花钱 / 能动电脑的）一句风险；卡上就地连；
 * - 缺设置 → 一张 `setup_request`：缺哪几格（服务端登记的 {@link SetupTarget} 给格子与建议值）；卡上就地填。
 *
 * **同一缺项不重复出卡**：去重键只看缺的是哪几样；还有一张没处理，就把这件事挂到那一张的「等着的」上。
 * **补完自动接着做**：人在卡上连好（卡自己点「接着做」）/ 在别处连好（连接清单一变就复查）/ 填好保存 →
 * 这张卡上等着的每一件事都按原来那段话再跑一次（照 WP304 选主题卡）。
 *
 * 纪律：这里**没有一个凭据的值**。连接卡只带「要连谁」；口令在本机原生表单里填、直接打连接面，
 * 不经这里、不进卡、不进事件、不进模型上下文。配置卡只收登记过的、不是秘密的格子
 * （{@link isSecretLikeSetupKey} 认出来的格子登记时就拒）。
 *
 * 只把**通用机制**做成固定功能：哪一家服务怎么连由连接目录 / 渠道登记表说了算，这里不为谁写专属分支；
 * 设置目标由各模块自己登记（{@link SetupCardsAssembly.registerTarget}）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type ApprovalBus,
  type ApprovalItem,
  type Clock,
  type ConnectNeed,
  type ConnectRequestPayload,
  connectRequestDedupeKey,
  isSecretLikeSetupKey,
  type MatterRunBlock,
  type RunRequest,
  type SetupField,
  type SetupRequestPayload,
  type SetupResumeTarget,
  setupRequestDedupeKey,
} from '@agentsws/contracts'
import { finalPayload } from '@agentsws/txn'

/** 一个设置目标（某个模块登记的「这几格设好了，我就能接着做」）。 */
export interface SetupTarget {
  /** 全局唯一（`site.store`、`company.address`）；工具回 `needs_setup: '<id>'` 认的就是它。 */
  id: string
  /** 人话名（时间线「缺一步设置（X）」用）。 */
  name: string
  /** 卡面那一句为什么。 */
  why: string
  /** 现在要填的几格（带建议值）。不能有秘密格（登记 / 出卡时都查）。 */
  fields(): Promise<SetupField[]>
  /** 已经设好了没有（设好了就不出卡；出了的卡保存后也按它复核）。 */
  satisfied(): Promise<boolean>
  /** 存下人填的值（只含登记过的格子）；不合法就抛 {@link SetupCardError}（那一句给人看）。 */
  apply(values: Record<string, string>): Promise<void>
}

export class SetupCardError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'secret_field' | 'unknown_target',
    message: string,
  ) {
    super(message)
    this.name = 'SetupCardError'
  }
}

/** 连上之后会怎样的那一句风险（只有花钱 / 能动东西的才有）。按 service 认，不按哪一家写分支。 */
const RISK_BY_SERVICE: Readonly<Record<string, string>> = {
  meta_ads: '连上后我只看数和起草；花钱、改预算的每一步都先出卡等你点头。',
  meta_marketing: '连上后我只看数和起草；花钱、改预算的每一步都先出卡等你点头。',
  google_ads: '连上后我只看数和起草；花钱、改预算的每一步都先出卡等你点头。',
  extension: '配上后插件只和这台电脑上的工坊说话；它看到的网页只用来做这件事。',
  shop_admin: '授权后改商品、页面的每一步都先出卡等你点头。',
}

export interface SetupCardsOptions {
  workspace_id: string
  clock: Clock
  /** 这个品牌的落盘目录（记「哪张卡上等着哪几件事」）；不给就全内存。 */
  dir?: string
  approvals(): ApprovalBus | undefined
  /** 出了新卡：挂进事项时间线 + 回填待办（`work.onCard`）。 */
  onCard?(item: ApprovalItem): void
  /**
   * 这一样现在连上了没有：`true` / `false`；认不出（没有办法查）回 `undefined`——
   * 人点「接着做」时就信人，不再拦。
   */
  isConnected(need: ConnectNeed): Promise<boolean | undefined>
  /** 补完：按这件事原来那段话再跑一次（`text` 是时间线上开跑那一行）。 */
  resume(target: SetupResumeTarget & { text: string }): Promise<void>
  /** 事项时间线上记一句（系统口吻）。 */
  note?(matter_id: string, text: string): void
  /** 审计事件（只有 id / 种类 / 数字，没有任何值）。 */
  emit?(type: string, payload: Record<string, unknown>): void
}

export interface SetupCardsAssembly {
  /** 登记一个设置目标；回注销函数。 */
  registerTarget(target: SetupTarget): () => void
  /** 运行时：一轮卡在缺连接 / 缺设置上 → 出卡（或挂到已有那张上）。 */
  onRunBlocked(input: {
    run_id: string
    matter_id: string
    actor: RunRequest['actor']
    block: MatterRunBlock
    needs: ConnectNeed[]
    targets: string[]
  }): Promise<{ item: ApprovalItem; attach: boolean } | undefined>
  /**
   * 别的模块直接要一张连接卡（WP322 / WP323 这类「要先接上 X 才能做」的确认流程用）。
   * 都连上了就不出、回 `undefined`。
   */
  askConnect(input: AskConnectInput): Promise<{ item: ApprovalItem; attach: boolean } | undefined>
  /** 别的模块直接要一张配置卡；设好了就不出、回 `undefined`。 */
  askSetup(input: AskSetupInput): Promise<{ item: ApprovalItem; attach: boolean } | undefined>
  /** 这两种卡被决定了（接着做 / 保存 / 先不连 / 先不设）。别的卡什么都不做。 */
  onDecided(item: ApprovalItem): Promise<void>
  /** 连接清单变了：还在等的连接卡里，缺的都连上了的那几张自动收起、接着做。回接着做了几张。 */
  recheck(): Promise<number>
}

export interface AskConnectInput {
  needs: ConnectNeed[]
  why?: string
  risk?: string
  actor: RunRequest['actor']
  matter_id?: string
  run_id?: string
}

export interface AskSetupInput {
  target: string
  why?: string
  /** 调用方（模型 / 规则）给的建议值，压过目标自己的建议。只认登记过的格子。 */
  suggestions?: Record<string, string>
  actor: RunRequest['actor']
  matter_id?: string
  run_id?: string
}

/** 落盘：哪张卡上等着哪几件事（卡本身在审批总线里）。 */
interface CardRecord {
  kind: 'connect_request' | 'setup_request'
  dedupe_key: string
  waiting: SetupResumeTarget[]
  /** 补完 / 不要了：再收到决定或连接变化都不再动。 */
  done?: true
}
interface StateFile {
  version: 1
  cards: Record<string, CardRecord>
}

const ACTIVE_STATES = new Set(['pending', 'in_review', 'deferred'])

export function createSetupCards(options: SetupCardsOptions): SetupCardsAssembly {
  const ws = options.workspace_id
  const file = options.dir === undefined ? undefined : join(options.dir, 'setup-cards.json')
  const targets = new Map<string, SetupTarget>()
  const state: StateFile = load()
  /** 同一张卡同一时间只结一次（人点「接着做」与连接清单变化可能前后脚到）。 */
  const settling = new Set<string>()

  function load(): StateFile {
    if (file === undefined) return { version: 1, cards: {} }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateFile>
      return { version: 1, cards: raw.cards ?? {} }
    } catch {
      return { version: 1, cards: {} }
    }
  }
  const save = (): void => {
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
    } catch {
      // 写不下只丢「等着的」清单：卡还在，人补完照样能在事项里说「接着做」
    }
  }
  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      options.emit?.(type, { workspace_id: ws, ...payload })
    } catch {
      // 审计事件失败不拦正事
    }
  }
  const note = (matter_id: string, text: string): void => {
    try {
      options.note?.(matter_id, text)
    } catch {
      // 事项已经没了
    }
  }

  const resumeOf = (
    actor: RunRequest['actor'],
    matter_id?: string,
  ): SetupResumeTarget | undefined =>
    matter_id === undefined
      ? undefined
      : { matter_id, person_id: actor.person_id, assignment_id: actor.assignment_id }

  /** 还在等人处理的那张（去重键一致、总线上还没定）。 */
  const activeCard = async (
    bus: ApprovalBus,
    dedupe_key: string,
  ): Promise<{ id: string; item: ApprovalItem; rec: CardRecord } | undefined> => {
    for (const [id, rec] of Object.entries(state.cards)) {
      if (rec.dedupe_key !== dedupe_key || rec.done === true) continue
      const item = await bus.get(id).catch(() => undefined)
      if (item !== undefined && ACTIVE_STATES.has(item.state)) return { id, item, rec }
    }
    return undefined
  }

  /** 把这件事挂到这张卡的「等着的」上；挂上了（原来没有）回 `true`。 */
  const attachTo = (rec: CardRecord, resume: SetupResumeTarget | undefined): boolean => {
    if (resume === undefined) return false
    if (rec.waiting.some((w) => w.matter_id === resume.matter_id)) return false
    rec.waiting.push(resume)
    save()
    return true
  }

  const cardBase = (input: {
    actor: RunRequest['actor']
    matter_id?: string | undefined
    run_id?: string | undefined
    object: { type: string; id: string }
  }) => ({
    workspace_id: ws as never,
    schema_version: 1 as const,
    role_id: input.actor.role_id as never,
    subject: {
      object: input.object,
      ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id as never }),
    },
    evidence: {
      ...(input.run_id === undefined ? {} : { run_id: input.run_id as never }),
      source_events: [],
      provenance: { seen: [] },
      precheck: {},
    },
    proposer: {
      kind: 'system' as const,
      id: 'setup_cards',
      assignment_id: input.actor.assignment_id as never,
    },
    automation: {
      level_at_creation: 'L1' as const,
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: input.actor.person_id as never, via: 'role_holder' as const }],
      rule: 'role_holder' as const,
      escalation: {
        after_hours: 24,
        business_hours: true,
        chain: ['owner' as const],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'immediate' as const,
    risk_class: 'low' as const,
  })

  const namesOf = (needs: readonly ConnectNeed[]): string => needs.map((n) => n.name).join('、')

  const askConnect: SetupCardsAssembly['askConnect'] = async (input) => {
    const bus = options.approvals()
    if (bus === undefined) return undefined
    // 已经连上的不再要（认不出的照样要：卡上给接法，人自己判断）
    const needs: ConnectNeed[] = []
    for (const n of input.needs) {
      if (needs.some((x) => x.kind === n.kind)) continue
      const connected = await options.isConnected(n).catch(() => undefined)
      if (connected === true && n.state !== 'reauth') continue
      needs.push(n)
    }
    if (needs.length === 0) return undefined
    const dedupe_key = connectRequestDedupeKey(ws, needs)
    const resume = resumeOf(input.actor, input.matter_id)
    const prior = await activeCard(bus, dedupe_key)
    if (prior !== undefined) {
      const attach = attachTo(prior.rec, resume)
      emit('setup_card.reused', { card_id: prior.id, kind: 'connect_request', attach })
      return { item: prior.item, attach }
    }
    const risk =
      input.risk ??
      needs
        .map((n) => (n.service === undefined ? undefined : RISK_BY_SERVICE[n.service]))
        .find((r) => r !== undefined)
    const payload: ConnectRequestPayload = {
      form: 'connect_request',
      why: input.why ?? `这件事要用到${namesOf(needs)}，连上我就接着做。`,
      needs,
      ...(risk === undefined ? {} : { risk }),
      ...(resume === undefined ? {} : { resume }),
    }
    const item = await bus.create({
      ...cardBase({
        actor: input.actor,
        matter_id: input.matter_id,
        run_id: input.run_id,
        object: { type: 'connection', id: needs.map((n) => n.kind).join('+') },
      }),
      kind: 'connect_request',
      dedupe_key,
      title: `先连上${namesOf(needs)}`,
      summary: payload.why,
      payload,
    } as never)
    state.cards[item.id] = {
      kind: 'connect_request',
      dedupe_key,
      waiting: resume === undefined ? [] : [resume],
    }
    save()
    emit('setup_card.asked', {
      card_id: item.id,
      kind: 'connect_request',
      needs: needs.map((n) => n.kind),
    })
    return { item, attach: resume !== undefined }
  }

  /** 目标的格子（查一遍没有秘密格）+ 调用方的建议值。 */
  const fieldsOf = async (
    target: SetupTarget,
    suggestions: Record<string, string> | undefined,
  ): Promise<SetupField[]> => {
    const fields = await target.fields()
    for (const f of fields)
      if (isSecretLikeSetupKey(f.key, f.label))
        throw new SetupCardError(
          'secret_field',
          `「${f.label}」像是口令 / 密钥，不能放进配置卡（只能在连接卡的本机表单里填）。`,
        )
    return fields.map((f) => {
      const s = suggestions?.[f.key]
      return s === undefined || s.trim() === '' ? f : { ...f, suggested: s.trim() }
    })
  }

  const askSetup: SetupCardsAssembly['askSetup'] = async (input) => {
    const bus = options.approvals()
    const target = targets.get(input.target)
    if (bus === undefined || target === undefined) return undefined
    if (await target.satisfied().catch(() => false)) return undefined
    const dedupe_key = setupRequestDedupeKey(ws, target.id)
    const resume = resumeOf(input.actor, input.matter_id)
    const prior = await activeCard(bus, dedupe_key)
    if (prior !== undefined) {
      const attach = attachTo(prior.rec, resume)
      emit('setup_card.reused', { card_id: prior.id, kind: 'setup_request', attach })
      return { item: prior.item, attach }
    }
    const fields = await fieldsOf(target, input.suggestions)
    if (fields.length === 0) return undefined
    const payload: SetupRequestPayload = {
      form: 'setup_request',
      target: target.id,
      why: input.why ?? target.why,
      fields,
      ...(resume === undefined ? {} : { resume }),
    }
    const item = await bus.create({
      ...cardBase({
        actor: input.actor,
        matter_id: input.matter_id,
        run_id: input.run_id,
        object: { type: 'setting', id: target.id },
      }),
      kind: 'setup_request',
      dedupe_key,
      title: `先设好${target.name}`,
      summary: payload.why,
      payload,
    } as never)
    state.cards[item.id] = {
      kind: 'setup_request',
      dedupe_key,
      waiting: resume === undefined ? [] : [resume],
    }
    save()
    emit('setup_card.asked', { card_id: item.id, kind: 'setup_request', target: target.id })
    return { item, attach: resume !== undefined }
  }

  const onRunBlocked: SetupCardsAssembly['onRunBlocked'] = async (input) => {
    const common = { actor: input.actor, matter_id: input.matter_id, run_id: input.run_id }
    // 缺连接比缺设置根本：两样都有先连
    if (input.needs.length > 0) {
      const needs =
        input.block.reason === 'missing_credential'
          ? input.needs.map((n) => ({ ...n, state: 'reauth' as const }))
          : input.needs
      const out = await askConnect({ ...common, needs })
      if (out !== undefined) return out
    }
    for (const target of input.targets) {
      const out = await askSetup({ ...common, target })
      if (out !== undefined) return out
    }
    return undefined
  }

  /** 这张卡上等着的每件事都接着做（只做一次）。 */
  const settle = async (id: string, rec: CardRecord, text: string): Promise<number> => {
    if (rec.done === true || settling.has(id)) return 0
    settling.add(id)
    try {
      rec.done = true
      save()
      let n = 0
      for (const w of rec.waiting) {
        try {
          await options.resume({ ...w, text })
          n += 1
        } catch {
          note(w.matter_id, '补好了，但这件事没能接着跑起来；在这里说一句「接着做」就行。')
        }
      }
      emit('setup_card.resumed', { card_id: id, kind: rec.kind, resumed: n })
      return n
    } finally {
      settling.delete(id)
    }
  }

  /** 还缺哪几样（认不出的当连上了：人说连好了就信人）。 */
  const stillMissing = async (needs: readonly ConnectNeed[]): Promise<ConnectNeed[]> => {
    const out: ConnectNeed[] = []
    for (const n of needs)
      if ((await options.isConnected(n).catch(() => undefined)) === false) out.push(n)
    return out
  }

  /** 卡没成（还没连上 / 填得不对）：给等着的事项说一句，再出一张新的（把等着的带过去）。 */
  const reask = async (item: ApprovalItem, rec: CardRecord, text: string): Promise<void> => {
    rec.done = true
    save()
    for (const w of rec.waiting) note(w.matter_id, text)
    const first = rec.waiting[0]
    const actor = {
      person_id: (first?.person_id ?? item.routing.recipients[0]?.person ?? '') as never,
      assignment_id: (first?.assignment_id ?? item.proposer.assignment_id ?? '') as never,
      role_id: item.role_id,
    } as RunRequest['actor']
    const payload = item.payload as ConnectRequestPayload | SetupRequestPayload
    const out =
      payload.form === 'connect_request'
        ? await askConnect({
            actor,
            needs: payload.needs,
            why: payload.why,
            ...(first === undefined ? {} : { matter_id: first.matter_id }),
          })
        : await askSetup({
            actor,
            target: payload.target,
            why: payload.why,
            ...(first === undefined ? {} : { matter_id: first.matter_id }),
          })
    if (out === undefined) return
    const next = state.cards[out.item.id]
    if (next !== undefined) for (const w of rec.waiting.slice(1)) attachTo(next, w)
    try {
      options.onCard?.(out.item)
    } catch {
      // 挂不上事项不影响卡本身
    }
  }

  const onDecided: SetupCardsAssembly['onDecided'] = async (item) => {
    if (item.kind !== 'connect_request' && item.kind !== 'setup_request') return
    const rec = state.cards[item.id]
    if (rec === undefined || rec.done === true) return
    const action = item.decision?.action
    if (action === 'reject') {
      rec.done = true
      save()
      for (const w of rec.waiting)
        note(
          w.matter_id,
          item.kind === 'connect_request'
            ? '先不连了，这件事停在这儿。'
            : '先不设了，这件事停在这儿。',
        )
      emit('setup_card.declined', { card_id: item.id, kind: item.kind })
      return
    }
    if (action !== 'approve' && action !== 'approve_edited') return
    if (item.kind === 'connect_request') {
      const payload = item.payload as ConnectRequestPayload
      const missing = await stillMissing(payload.needs)
      if (missing.length > 0) {
        await reask(item, rec, `还没连上${namesOf(missing)}，连好会自动接着做。`)
        return
      }
      await settle(item.id, rec, '连好了，接着做')
      return
    }
    const payload = finalPayload(item) as SetupRequestPayload
    const target = targets.get(payload.target)
    if (target === undefined) {
      rec.done = true
      save()
      return
    }
    try {
      await target.apply(valuesOf(payload))
    } catch (e) {
      const why = e instanceof Error ? e.message : '没存成'
      await reask(item, rec, `没存成：${why}`)
      return
    }
    emit('setup_card.saved', { card_id: item.id, target: target.id })
    await settle(item.id, rec, '设好了，接着做')
  }

  const recheck: SetupCardsAssembly['recheck'] = async () => {
    const bus = options.approvals()
    if (bus === undefined) return 0
    let n = 0
    for (const [id, rec] of Object.entries(state.cards)) {
      if (rec.done === true || rec.kind !== 'connect_request') continue
      const item = await bus.get(id).catch(() => undefined)
      if (item === undefined || !ACTIVE_STATES.has(item.state)) continue
      const payload = item.payload as ConnectRequestPayload
      // 认不出的不算连上（没人点，不替人判断）
      let all = true
      for (const need of payload.needs)
        if ((await options.isConnected(need).catch(() => undefined)) !== true) all = false
      if (!all) continue
      // 在别处（连接页 / 第三栏）连好了：卡自己收起，等着的接着做
      await bus.withdraw(id, 'system' as never).catch(() => undefined)
      n += (await settle(id, rec, '连好了，接着做')) > 0 ? 1 : 0
    }
    return n
  }

  return {
    registerTarget(target) {
      if (targets.has(target.id))
        throw new SetupCardError('invalid_input', `设置目标重复登记：${target.id}`)
      targets.set(target.id, target)
      return () => {
        if (targets.get(target.id) === target) targets.delete(target.id)
      }
    },
    onRunBlocked,
    askConnect,
    askSetup,
    onDecided,
    recheck,
  }
}

/**
 * 卡上带回的值 → 只留登记过的格子（多的扔掉）；人没改的用建议值；必填空着就拒。
 * 秘密格子在出卡时就拒了，这里再兜一道（带回来的值里有像秘密的键也扔）。
 */
export function valuesOf(payload: SetupRequestPayload): Record<string, string> {
  const given = payload.values ?? {}
  const out: Record<string, string> = {}
  for (const f of payload.fields) {
    if (isSecretLikeSetupKey(f.key, f.label)) continue
    const raw = given[f.key] ?? f.suggested ?? ''
    const v = typeof raw === 'string' ? raw.trim() : String(raw)
    if (v === '') {
      if (f.required) throw new SetupCardError('invalid_input', `「${f.label}」还没填。`)
      continue
    }
    if (f.kind === 'select' && f.options !== undefined && !f.options.some((o) => o.value === v))
      throw new SetupCardError('invalid_input', `「${f.label}」不在可选的里面。`)
    out[f.key] = v
  }
  return out
}
