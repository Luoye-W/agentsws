/**
 * WP320：**AI 随工作自动记**（照 Claude 的做法）。
 *
 * 一次运行跑完，从这次对话里提炼值得以后一直记住的东西，写进这次运行所在的那一层记忆
 * （岗位 / 职责；整个品牌都适用的写品牌层）。三个来源，同一套过滤：
 *
 * 1. **人明确说了「记住…」**（`asked`）——不靠模型，规则就认得出；「自动记忆」关了也照记；
 * 2. **模型在交代末尾写的 `<remember>…</remember>`**——提示词里有一段规矩教它什么该记、什么不记
 *    （{@link rememberRule}）；宿主进时间线之前把标记拿掉（同 `<next>`）；
 * 3. **人话里带「以后 / 下次 / 一律 / 别再…」的那一句**（`correction` / `preference`）——规则保底，
 *    没接模型（stub）时也有东西可记。
 *
 * 过滤（{@link screenMemoryText}）：只记稳定的偏好 / 事实 / 纠正过的做法；一次性内容（这单、今天、
 * 某个订单号）、密钥 / 账号 / 口令、个人敏感信息（邮箱、电话、证件、卡号…）一律不记。
 * 去重与合并：与这一层已有的一样就不记；很像 AI 以前记的那条就并进去（换成新说法）；
 * 很像人写的那条就不碰（不替人改字）；人删掉过的不再记回来（墓碑），除非人又明说「记住」。
 * 一次运行最多记 {@link AUTO_MEMORY_MAX_PER_RUN} 条。
 *
 * 写入走 `learning.addMemory` / `updateMemory`——与人手写的同一条路，所以记忆面板里看得见、
 * 改得了、删得掉；删掉之后下一次运行的上下文里就没有它（{@link AutoMemory.section} 现取现拼）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  MaybePromise,
  MemoryFact,
  PersonId,
  PromptSection,
  RunId,
  SkillTier,
  WorkspaceId,
} from '@agentsws/contracts'
import { detectSecret, jaccard } from '@agentsws/knowledge'
import type { LearningAssembly, MemoryEntry, MemoryTarget } from './learning.js'
import type { MemoryReason } from './memory-book.js'

/** 一次运行最多自动记几条。 */
export const AUTO_MEMORY_MAX_PER_RUN = 3
/** 一条记忆的长短（字）。 */
export const AUTO_MEMORY_MIN_CHARS = 4
export const AUTO_MEMORY_MAX_CHARS = 200
/** 与已有的一条像到这个份上就算同一条（不记）。 */
export const AUTO_MEMORY_SAME = 0.85
/** 像到这个份上就算同一件事的新说法（并进 AI 以前记的那条；人写的不碰；删过的不再记）。 */
export const AUTO_MEMORY_SIMILAR = 0.5
/**
 * 提示词里「记忆」那一段的位置。WP472（docs/116 §2 第 7 条）：从 26（公共段之后）挪到技能索引（90）之后——
 * 记忆一写新的这一段就变，排在技能正文前面时后面的技能正文、索引全跟着不命中缓存。内容一个字不改，只换位置。
 */
export const MEMORY_SECTION_ORDER = 92
/** 提示词里最多列几条记忆（再多的仍在技能正文 / 面板里，只是不在这一段重复）。 */
export const MEMORY_SECTION_MAX = 30

export type MemoryLayerHint = 'brand' | 'position' | 'role'

/** 模型写的一条 `<remember>`。 */
export interface RememberItem {
  text: string
  layer?: MemoryLayerHint
  kind?: 'preference' | 'correction' | 'fact'
}

const REMEMBER_TAG = /<remember\b([^>]*)>([\s\S]*?)<\/remember>/giu
const ATTR = (name: string): RegExp => new RegExp(`${name}\\s*=\\s*["']?([a-z]+)["']?`, 'iu')

/**
 * 答复里的 `<remember>…</remember>` → `{ text: 去掉标记的正文, items }`。
 * 标记里是空的就当没写；`layer` / `kind` 认不出就当没给。
 */
export function splitRememberTags(text: string): { text: string; items: RememberItem[] } {
  const hits = [...text.matchAll(REMEMBER_TAG)]
  if (hits.length === 0) return { text, items: [] }
  const items: RememberItem[] = []
  for (const hit of hits) {
    const attrs = hit[1] ?? ''
    const body = (hit[2] ?? '').replace(/\s+/gu, ' ').trim()
    if (body === '') continue
    const layer = ATTR('layer').exec(attrs)?.[1]?.toLowerCase()
    const kind = ATTR('kind').exec(attrs)?.[1]?.toLowerCase()
    items.push({
      text: body,
      ...(layer === 'brand' || layer === 'position' || layer === 'role' ? { layer } : {}),
      ...(kind === 'preference' || kind === 'correction' || kind === 'fact' ? { kind } : {}),
    })
  }
  const stripped = text
    .replace(REMEMBER_TAG, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd()
  return { text: stripped, items }
}

/** 给模型的那段规矩。「自动记忆」关了就只在人明说「记住」时写。 */
export function rememberRule(auto: boolean): string {
  return auto
    ? '这次对话里如果出现值得以后一直记住的东西——用户稳定的偏好、纠正过你的做法、这家店长期不变的事实——' +
        '在交代最后单独起一行写 <remember>一句话</remember>（最多 3 行，像「回复美国客户一律用英文」）；' +
        '整个品牌都适用的写 <remember layer="brand">…</remember>。' +
        '一次性的事（这一单、今天、某个订单号）、密码 / 账号 / 密钥、个人敏感信息一律不记；没有就不写。不要在别处提这个标记。'
    : '只有用户明确说「记住…」时，才在交代最后单独起一行写 <remember>要记的那句话</remember>；别的时候不写。' +
        '密码 / 账号 / 密钥、个人敏感信息不记。不要在别处提这个标记。'
}

const SENTENCE = /[^。！？!?\n；;]+[。！？!?；;]?/gu
const sentencesOf = (text: string): string[] =>
  (text.match(SENTENCE) ?? []).map((s) => s.trim()).filter((s) => s !== '')

const cleanText = (raw: string): string =>
  raw
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[：:，,、\s"'“”‘’「」]+|["'“”‘’「」\s]+$/gu, '')
    .replace(/[。.]$/u, '')
    .trim()

const ASK =
  /(?:^|[^不没别])(?:请|帮我|你)?(?:要)?记住(?:了)?(?:这件事|这一点|一下)?[：:，,\s]*(.*)$/u
const ASK_EN = /^\s*(?:please\s+)?remember(?:\s+that)?[:,]?\s+(.+)$/iu

/** 「记住」后面只跟着这些 = 「把（你刚说的）这个记住」：算人明说了，但自己没有正文。 */
const FILLER = /^(?:这个|这些|这件事|这一点|这条|它|一下|哦|啊|呀|吧)?$/u

/**
 * 人明确说「记住…」：`asked` = 这次人明说了（问句「记住了吗」不算）；`texts` = 「记住」后面那一截
 * （只是「记住这个」的没有正文——那时记的是模型这次写的 `<remember>`）。
 */
export function rememberAsk(brief: string): { asked: boolean; texts: string[] } {
  let asked = false
  const texts: string[] = []
  for (const s of sentencesOf(brief)) {
    const hit = ASK.exec(s) ?? ASK_EN.exec(s)
    if (hit === null || /[吗么？?]\s*$/u.test(s)) continue
    asked = true
    const body = cleanText(hit[1] ?? '')
    if (!FILLER.test(body) && [...body].length >= AUTO_MEMORY_MIN_CHARS) texts.push(body)
  }
  return { asked, texts }
}

/** 人明确说「记住…」的那几句（取「记住」后面那一截）。 */
export const askedToRemember = (brief: string): string[] => rememberAsk(brief).texts

/** 这次人明说了「记住」（「自动记忆」关了也照记，删过的也再记）。 */
export const mentionsRemember = (brief: string): boolean => rememberAsk(brief).asked

const CORRECTION = /(不要再|别再|不要|别|不许|不能|改成|改为|换成)/u
const CUE = /(以后|今后|往后|下次|每次都|一律|永远|总是|从现在起|从今往后|记得)/u

/** 人话里「以后 / 下次 / 一律 / 别再…」那几句（规则保底）。带「记住」的不算（那是 {@link askedToRemember}）。 */
export function cueSentences(brief: string): { text: string; reason: MemoryReason }[] {
  const out: { text: string; reason: MemoryReason }[] = []
  for (const s of sentencesOf(brief)) {
    if (/记住|remember/iu.test(s) || !CUE.test(s)) continue
    const text = cleanText(s)
    if (text !== '') out.push({ text, reason: CORRECTION.test(s) ? 'correction' : 'preference' })
  }
  return out
}

const SENSITIVE =
  /(密码|口令|验证码|密钥|私钥|令牌|token|api[ _-]?key|secret|password|passwd|账号|帐号|登录名|用户名|身份证|护照|银行卡|卡号|手机号|电话号码|家庭住址|住址)/iu
const ONE_OFF =
  /(今天|明天|昨天|今晚|刚才|刚刚|这次|本次|这一次|这单|这一单|这封|这条消息|订单号|单号|#\d{3,}|\d{1,2}月\d{1,2}[日号])/u

/** 一条候选能不能记（不能就说为什么）。`asked` = 人明说「记住」的，一次性那条放过（人要记就记）。 */
export function screenMemoryText(
  raw: string,
  opts: { asked?: boolean } = {},
): { ok: true; text: string } | { ok: false; reason: string } {
  const text = cleanText(raw)
  const n = [...text].length
  if (n < AUTO_MEMORY_MIN_CHARS) return { ok: false, reason: 'too_short' }
  if (n > AUTO_MEMORY_MAX_CHARS) return { ok: false, reason: 'too_long' }
  if (detectSecret(text) !== undefined) return { ok: false, reason: 'secret' }
  if (SENSITIVE.test(text)) return { ok: false, reason: 'sensitive' }
  if (opts.asked !== true && ONE_OFF.test(text)) return { ok: false, reason: 'one_off' }
  return { ok: true, text }
}

/** 一条要记的东西（来源已经归好了类）。 */
export interface MemoryCandidate {
  text: string
  reason: MemoryReason
  asked: boolean
  layer?: MemoryLayerHint
}

const normalize = (s: string): string => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/**
 * 三个来源合成一份候选（先人明说的，再模型的，再规则保底），同一件事只留一条。
 * `auto: false` = 「自动记忆」关了：只留人明说的；模型写的只有人这次也明说了「记住」才算。
 */
export function memoryCandidatesOf(input: {
  brief: string
  items: readonly RememberItem[]
  runtime?: readonly MemoryFact[]
  auto: boolean
}): MemoryCandidate[] {
  const ask = rememberAsk(input.brief)
  const askedNow = ask.asked
  const all: MemoryCandidate[] = ask.texts.map((text) => ({ text, reason: 'asked', asked: true }))
  if (input.auto || askedNow) {
    for (const item of input.items)
      all.push({
        text: item.text,
        reason: askedNow ? 'asked' : (item.kind ?? 'preference'),
        asked: askedNow,
        ...(item.layer === undefined ? {} : { layer: item.layer }),
      })
  }
  if (input.auto) {
    for (const fact of input.runtime ?? [])
      all.push({
        text: fact.value,
        reason:
          fact.category === 'constraint'
            ? 'correction'
            : fact.category === 'preference'
              ? 'preference'
              : 'fact',
        asked: false,
      })
    for (const cue of cueSentences(input.brief))
      all.push({ text: cue.text, reason: cue.reason, asked: false })
  }
  const out: MemoryCandidate[] = []
  for (const c of all) {
    const same = out.find(
      (o) =>
        normalize(o.text) === normalize(c.text) || jaccard(o.text, c.text) >= AUTO_MEMORY_SIMILAR,
    )
    if (same === undefined) out.push(c)
    else if (same.layer === undefined && c.layer !== undefined) same.layer = c.layer
  }
  return out
}

/** 「设置 → 通用」里的「自动记忆」：每个人在每个品牌里一份，默认开。 */
export interface AutoMemorySettings {
  get(workspace_id: WorkspaceId, person_id: PersonId): boolean
  set(workspace_id: WorkspaceId, person_id: PersonId, enabled: boolean): boolean
}

export function createAutoMemorySettings(options: { dir?: string } = {}): AutoMemorySettings {
  const file = options.dir === undefined ? undefined : join(options.dir, 'auto-memory.json')
  let state: Record<string, boolean> = {}
  if (file !== undefined && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (parsed !== null && typeof parsed === 'object')
        state = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (e): e is [string, boolean] => typeof e[1] === 'boolean',
          ),
        )
    } catch {
      // 读坏了回缺省（它只是偏好）
    }
  }
  const key = (ws: string, person: string): string => `${ws}|${person}`
  return {
    get: (ws, person) => state[key(ws, person)] ?? true,
    set(ws, person, enabled) {
      state = { ...state, [key(ws, person)]: enabled }
      if (file !== undefined) {
        mkdirSync(options.dir as string, { recursive: true })
        writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      }
      return enabled
    },
  }
}

/** 一次运行是谁、在哪一层跑的。 */
export interface RunMemoryActor {
  person_id: PersonId
  workspace_id: WorkspaceId
  position_id?: string
  role_id: string
}

export interface AutoMemoryOutcome {
  written: MemoryEntry[]
  merged: MemoryEntry[]
  skipped: { text: string; reason: string }[]
}

export interface AutoMemory {
  /**
   * 提示词里「记忆」那一段：这次运行这几层（品牌 / 岗位 / 职责）现有的记忆——**技能正文里已经
   * 有的不重复列**（`loaded_skills` 那几本叠出来的正文里本来就带着这几层的段）——再加记忆规矩。
   * 每次运行现取：人删掉的那条，下一次运行就没有了。
   */
  section(actor: RunMemoryActor, loaded_skills: readonly string[]): PromptSection
  /** 运行跑完：提炼 → 过滤 → 去重 / 合并 → 写。 */
  afterRun(input: {
    run_id: RunId
    matter_id?: string
    actor: RunMemoryActor
    brief: string
    items: readonly RememberItem[]
    runtime?: readonly MemoryFact[]
  }): Promise<AutoMemoryOutcome>
  readonly settings: AutoMemorySettings
}

const LAYER_LABEL: Readonly<Partial<Record<SkillTier, string>>> = {
  company: '品牌',
  position: '岗位',
  role: '职责',
}

export function createAutoMemory(options: {
  learning: Pick<LearningAssembly, 'memoryAt' | 'addMemory' | 'updateMemory' | 'book'>
  settings: AutoMemorySettings
  /** 本人能不能写这一层（与记忆面板的 `can_edit` 同一份判据：`canEditMemory`）。 */
  canWrite(
    actor: { person_id: PersonId; workspace_id: WorkspaceId },
    target: MemoryTarget,
  ): MaybePromise<boolean>
}): AutoMemory {
  const { learning } = options

  /** 这次运行能看到的几层（品牌 → 岗位 → 职责）。 */
  const layersOf = (actor: RunMemoryActor): MemoryTarget[] => [
    { tier: 'company', workspace_id: actor.workspace_id },
    ...(actor.position_id === undefined
      ? []
      : [
          {
            tier: 'position' as const,
            scope_id: actor.position_id,
            workspace_id: actor.workspace_id,
          },
        ]),
    { tier: 'role', scope_id: actor.role_id, workspace_id: actor.workspace_id },
  ]

  /** 候选落哪一层：模型说了品牌层且本人写得动品牌层才去；默认岗位层（没有岗位就职责层）。 */
  const targetsFor = (c: MemoryCandidate, actor: RunMemoryActor): MemoryTarget[] => {
    const position: MemoryTarget[] =
      actor.position_id === undefined
        ? []
        : [{ tier: 'position', scope_id: actor.position_id, workspace_id: actor.workspace_id }]
    const role: MemoryTarget[] = [
      { tier: 'role', scope_id: actor.role_id, workspace_id: actor.workspace_id },
    ]
    if (c.layer === 'brand')
      return [{ tier: 'company', workspace_id: actor.workspace_id }, ...position, ...role]
    if (c.layer === 'role') return [...role, ...position]
    return [...position, ...role]
  }

  return {
    settings: options.settings,
    section(actor, loaded_skills) {
      const loaded = new Set(loaded_skills)
      const lines: string[] = []
      for (const target of layersOf(actor)) {
        for (const e of learning.memoryAt(target)) {
          if (loaded.has(e.skill) || lines.length >= MEMORY_SECTION_MAX) continue
          const body = e.body.replace(/\s+/gu, ' ').trim()
          if (body === '') continue
          lines.push(`- [${LAYER_LABEL[target.tier] ?? ''}] ${[...body].slice(0, 200).join('')}`)
        }
      }
      const auto = options.settings.get(actor.workspace_id, actor.person_id)
      const text = [
        ...(lines.length === 0 ? [] : ['照下面这些记忆做事（人可以随时改 / 删）：', ...lines, '']),
        rememberRule(auto),
      ].join('\n')
      return { id: 'memory', name: '记忆', order: MEMORY_SECTION_ORDER, text }
    },
    async afterRun(input) {
      const outcome: AutoMemoryOutcome = { written: [], merged: [], skipped: [] }
      const auto = options.settings.get(input.actor.workspace_id, input.actor.person_id)
      const candidates = memoryCandidatesOf({
        brief: input.brief,
        items: input.items,
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        auto,
      })
      const who = { person_id: input.actor.person_id, workspace_id: input.actor.workspace_id }
      for (const c of candidates) {
        if (outcome.written.length + outcome.merged.length >= AUTO_MEMORY_MAX_PER_RUN) {
          outcome.skipped.push({ text: c.text, reason: 'per_run_cap' })
          continue
        }
        const screened = screenMemoryText(c.text, { asked: c.asked })
        if (!screened.ok) {
          outcome.skipped.push({ text: c.text, reason: screened.reason })
          continue
        }
        let target: MemoryTarget | undefined
        for (const t of targetsFor(c, input.actor)) {
          if (await options.canWrite(who, t)) {
            target = t
            break
          }
        }
        if (target === undefined) {
          outcome.skipped.push({ text: screened.text, reason: 'forbidden' })
          continue
        }
        const existing = learning.memoryAt(target)
        const same = existing.find(
          (e) =>
            normalize(e.body) === normalize(screened.text) ||
            jaccard(e.body, screened.text) >= AUTO_MEMORY_SAME,
        )
        if (same !== undefined) {
          outcome.skipped.push({ text: screened.text, reason: 'duplicate' })
          continue
        }
        const scope_id =
          target.tier === 'company' ? input.actor.workspace_id : (target.scope_id ?? '')
        const buried = learning.book
          .tombstones({ workspace_id: input.actor.workspace_id, tier: target.tier, scope_id })
          .some((t) => jaccard(t, screened.text) >= AUTO_MEMORY_SIMILAR)
        if (buried && !c.asked) {
          outcome.skipped.push({ text: screened.text, reason: 'deleted_before' })
          continue
        }
        const origin = {
          written_by: 'ai' as const,
          run_id: input.run_id,
          ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
        }
        const similar = existing.find((e) => jaccard(e.body, screened.text) >= AUTO_MEMORY_SIMILAR)
        if (similar !== undefined) {
          // AI 以前记的那条：换成新说法（并进去）；人写的那条不替人改字
          if (similar.written_by !== 'ai' || similar.id === undefined) {
            outcome.skipped.push({ text: screened.text, reason: 'similar_to_human' })
            continue
          }
          outcome.merged.push(
            await learning.updateMemory(similar.id, {
              text: screened.text,
              by: input.actor.person_id,
              workspace_id: input.actor.workspace_id,
              merge: true,
              ...origin,
              reason: 'merge',
            }),
          )
          continue
        }
        outcome.written.push(
          await learning.addMemory({
            tier: target.tier,
            ...(target.tier === 'company' ? {} : { scope_id }),
            workspace_id: input.actor.workspace_id,
            text: screened.text,
            by: input.actor.person_id,
            ...origin,
            reason: c.reason,
          }),
        )
      }
      return outcome
    },
  }
}
