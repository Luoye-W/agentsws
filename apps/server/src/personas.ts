/**
 * WP120（69）：**角色定位**的服务端那一半——公司层覆盖、审计、以及"进系统提示的那几段"。
 *
 * 纯的那一半（取语言、叠覆盖、拼段、六段骨架校验）在 `@agentsws/roles` 的
 * `persona.ts`；这里只负责三件这个进程才做得了的事：
 *
 * 1. **覆盖存哪儿**（内存 / sqlite，与职责包的 `StoreBackend` 同一个形）；
 * 2. **谁能改**——只有公司层，而且只有 owner（69 §4：persona 是公司对外的口径，
 *    不是个人偏好；要个性化的东西在个人技能层里）；
 * 3. **每改一次记一条审计**（`persona.overridden` / `persona.reverted`）——
 *    它进系统提示，改了它等于改了 Agent 对外说什么。
 *
 * 包里的原文**一个字不动**：覆盖是另存的一层，所以「还原」永远做得到
 * （与技能的六层覆盖同一条规矩，24 §1）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  Clock,
  EventEnvelope,
  PersonaOverride,
  PersonaSubject,
  PersonaText,
  PersonaView,
  PersonId,
  Position,
  PromptSection,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  applyPersonaOverride,
  loadBundledPosition,
  type PersonaBrandContext,
  type PersonaLang,
  personaKey,
  personaSections,
  personaTextIn,
  type RoleStore,
} from '@agentsws/roles'

/** 覆盖表存哪儿。内存一份、磁盘一份——磁盘那份就是一个 JSON 文件（它很小，而且很少变）。 */
export interface PersonaBackend {
  all(): PersonaOverride[]
  put(row: PersonaOverride): void
  remove(subject: PersonaSubject): void
}

/** 内存后端（测试与 `--no-db` 的进程）。 */
export function createMemoryPersonaBackend(): PersonaBackend {
  const rows = new Map<string, PersonaOverride>()
  return {
    all: () =>
      [...rows.values()].sort((a, b) => personaKey(a.subject).localeCompare(personaKey(b.subject))),
    put: (row) => {
      rows.set(personaKey(row.subject), row)
    },
    remove: (subject) => {
      rows.delete(personaKey(subject))
    },
  }
}

/**
 * 文件后端。
 *
 * 不开一张 sqlite 表：这份数据一共几十行、几乎不变、而且要能被人直接看见
 * （"公司把红人那条改成什么了"是排障时第一个要看的东西）。一个 JSON 文件
 * 读得懂、备份得走、出了事改得回来。
 */
export function createFilePersonaBackend(file: string): PersonaBackend {
  const read = (): PersonaOverride[] => {
    if (!existsSync(file)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as PersonaOverride[]) : []
    } catch {
      // 文件坏了不该让进程起不来：当成"没有覆盖"，包里的原文照常生效
      return []
    }
  }
  const write = (rows: PersonaOverride[]): void => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
  }
  return {
    all: () => read().sort((a, b) => personaKey(a.subject).localeCompare(personaKey(b.subject))),
    put: (row) => {
      const rows = read().filter((r) => personaKey(r.subject) !== personaKey(row.subject))
      rows.push(row)
      write(rows)
    },
    remove: (subject) => {
      write(read().filter((r) => personaKey(r.subject) !== personaKey(subject)))
    },
  }
}

export interface PersonasOptions {
  workspace_id: WorkspaceId
  clock: Clock
  roles: RoleStore
  /** 岗位模板（`createOrg().positions()`）——模板是制度层的东西，这里只读。 */
  positions(): Position[]
  /** 覆盖存哪儿。不给就是内存。 */
  backend?: PersonaBackend
  /** 这个人是不是 owner（69 §4：只有 owner 改得了公司层 persona）。 */
  isOwner(person_id: PersonId): boolean
  /**
   * WP121：品牌上下文的四个槽位。**取不到就不写那一句**——
   * 这个回调回 `undefined` 或空对象时，persona 里一句品牌的话都不出现（69 §5「别编」）。
   */
  brand?(): PersonaBrandContext | undefined
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
}

export interface PersonasAssembly {
  /** 右栏「角色」面板要的那一份（岗位层 / 职责层各一）。 */
  view(subject: PersonaSubject): PersonaView
  /** 公司层改写。只有 owner；改完记一条 `persona.overridden`。 */
  set(input: { subject: PersonaSubject; text: PersonaText; by: PersonId }): PersonaView
  /** 还原成包里的原文。记一条 `persona.reverted`。 */
  revert(input: { subject: PersonaSubject; by: PersonId }): PersonaView
  /** 现在真正进系统提示的那一份（已叠覆盖）。 */
  effective(subject: PersonaSubject): PersonaText | undefined
  /**
   * WP120（69 §3）：装 `persona` 段的那几节（品牌 → 岗位 → 职责）。
   *
   * 运行时只调这一个口——排序、空段不出、语言、覆盖全在里面，
   * 三个运行时因此拿到逐字相同的那几段。
   */
  sections(input: {
    role_id: RoleId
    position_id?: string | undefined
    lang?: PersonaLang
  }): PromptSection[]
}

/** 这个错误码与职责包一致（API 层照着翻状态码）。 */
class PersonaError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'invalid_input',
    message: string,
  ) {
    super(message)
    this.name = 'PersonaError'
  }
}

export { PersonaError }

/**
 * persona 覆盖的正文上限。
 *
 * 比包里那条（`MAX_PERSONA_CHARS`）松：包里那份是我们自己写的，要守 200 字的纪律；
 * 公司改写的那份是**用户写的**，在一个文本框里卡到 260 字只会让人写到一半被拦住。
 * 松到这个数仍拦得住"把整本手册粘进来"（那种粘贴才是这个上限真正要防的）。
 */
const MAX_OVERRIDE_CHARS = 1200

export function createPersonas(options: PersonasOptions): PersonasAssembly {
  const backend = options.backend ?? createMemoryPersonaBackend()
  let traceSeq = 0

  const emit = (type: string, subject: PersonaSubject, by: PersonId): void => {
    traceSeq += 1
    options.appendEvent({
      schema_version: 1,
      workspace_id: options.workspace_id,
      type,
      actor: { kind: 'person', id: by },
      correlation: { trace_id: `tr_persona_${String(traceSeq).padStart(6, '0')}` },
      payload: { subject_kind: subject.kind, subject_id: subject.id },
    })
  }

  /**
   * 一个岗位模板（**persona 那一份以包里的 yml 为准**）。
   *
   * 存下来的那一行（`org.positions()`）管的是"这家公司有哪些岗位、各挂哪几条职责"，
   * 它种下去的那一刻就没带 `persona`——而 persona 的原文属于**包**（69 §4「包里的原文
   * 保留可还原」）。所以这里两步：先用存下来的那一行确认"公司确实有这个岗位"，
   * 再去包里取原文。
   *
   * 不把 persona 抄进存下来的那一行：抄进去就等于把原文冻在首次设置那天，
   * 之后包里改好的措辞一个都到不了老工作区，而「还原」还原的也会是那份旧快照。
   *
   * 公司自己建的岗位包里没有——那就没有原文，整段不出（54 §3「不猜一个」）。
   */
  const positionOf = (id: string): Position | undefined => {
    const stored = options.positions().find((p) => p.id === id)
    if (stored === undefined) return undefined
    let packaged: Position | undefined
    try {
      packaged = loadBundledPosition(id)
    } catch {
      packaged = undefined
    }
    return packaged?.persona === undefined ? stored : { ...stored, persona: packaged.persona }
  }

  /** 包里的原文 + 显示名。找不到这个岗位 / 职责就抛 `not_found`。 */
  const packagedOf = (
    subject: PersonaSubject,
  ): { name: { zh: string; en: string }; persona: PersonaText } => {
    if (subject.kind === 'position') {
      const template = positionOf(subject.id)
      if (template === undefined)
        throw new PersonaError('not_found', `没有「${subject.id}」这个岗位`)
      return { name: template.name, persona: template.persona ?? '' }
    }
    const role = options.roles.roles.get(subject.id as RoleId)
    if (role === undefined) throw new PersonaError('not_found', `没有「${subject.id}」这条职责`)
    return { name: role.name, persona: role.persona ?? '' }
  }

  const overrideOf = (subject: PersonaSubject): PersonaOverride | undefined =>
    backend.all().find((r) => personaKey(r.subject) === personaKey(subject))

  const viewOf = (subject: PersonaSubject): PersonaView => {
    const packaged = packagedOf(subject)
    const override = overrideOf(subject)
    const effective = applyPersonaOverride(packaged.persona, override?.text) ?? packaged.persona
    const overridden =
      override !== undefined &&
      (personaTextIn(effective, 'zh') !== personaTextIn(packaged.persona, 'zh') ||
        personaTextIn(effective, 'en') !== personaTextIn(packaged.persona, 'en'))
    return {
      subject,
      name: packaged.name,
      effective,
      packaged: packaged.persona,
      overridden,
      ...(override?.updated_at === undefined ? {} : { updated_at: override.updated_at }),
      ...(override?.updated_by === undefined ? {} : { updated_by: override.updated_by }),
    }
  }

  const effectiveOf = (subject: PersonaSubject): PersonaText | undefined => {
    try {
      const view = viewOf(subject)
      return personaTextIn(view.effective, 'zh') === '' &&
        personaTextIn(view.effective, 'en') === ''
        ? undefined
        : view.effective
    } catch {
      // 岗位反查不出来 / 职责不在册：没有这一段，整段不出（54 §3「不猜一个」）
      return undefined
    }
  }

  return {
    view: viewOf,
    effective: effectiveOf,

    set({ subject, text, by }) {
      if (!options.isOwner(by))
        throw new PersonaError(
          'forbidden',
          '角色定位是公司对外的口径，只有 owner 改得动（要个性化的东西写在个人技能层里）',
        )
      // 先确认这个岗位 / 职责真的在册（不在册的先抛 not_found，别落一条孤儿覆盖）
      packagedOf(subject)
      for (const lang of ['zh', 'en'] as const) {
        const body = personaTextIn(text, lang)
        if (body.length > MAX_OVERRIDE_CHARS)
          throw new PersonaError(
            'invalid_input',
            `角色定位最多 ${MAX_OVERRIDE_CHARS} 字，现在是 ${body.length} 字`,
          )
      }
      if (personaTextIn(text, 'zh') === '' && personaTextIn(text, 'en') === '')
        throw new PersonaError('invalid_input', '角色定位不能清空——要恢复原文请用「还原」')
      backend.put({
        workspace_id: options.workspace_id,
        subject,
        text,
        updated_at: options.clock.now(),
        updated_by: by,
      })
      emit('persona.overridden', subject, by)
      return viewOf(subject)
    },

    revert({ subject, by }) {
      if (!options.isOwner(by))
        throw new PersonaError('forbidden', '只有 owner 改得动公司层的角色定位')
      packagedOf(subject)
      backend.remove(subject)
      emit('persona.reverted', subject, by)
      return viewOf(subject)
    },

    sections({ role_id, position_id, lang }) {
      const role = options.roles.roles.get(role_id)
      const template = position_id === undefined ? undefined : positionOf(position_id)
      return personaSections({
        ...(lang === undefined ? {} : { lang }),
        ...(template === undefined
          ? {}
          : {
              position: {
                id: template.id,
                name: (lang ?? 'zh') === 'zh' ? template.name.zh : template.name.en,
                persona: effectiveOf({ kind: 'position', id: template.id }),
              },
            }),
        role: {
          id: role_id,
          ...(role === undefined
            ? {}
            : { name: (lang ?? 'zh') === 'zh' ? role.name.zh : role.name.en }),
          persona: effectiveOf({ kind: 'role', id: role_id }),
        },
        ...(options.brand === undefined ? {} : { brand: options.brand() }),
      })
    },
  }
}

/** 数据目录下覆盖表那个文件的位置（一个 JSON，见 `createFilePersonaBackend`）。 */
export const personaFileIn = (dbDir: string): string => join(dbDir, 'personas.json')
