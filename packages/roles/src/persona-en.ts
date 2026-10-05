/**
 * WP226（69 §1.1）：**英文 persona 是生成的**——这个文件管"生成的那一份放哪、怎么认、过没过期"。
 *
 * Luoye 10-05 定：persona 只手写中文；英文用翻译自动生成，不再手工维护。两份手工维护已经出过事
 * （docs/91 §3.3：14 条英文 persona 混着中文）。
 *
 * 生成的那一份是仓库里的一个 JSON（`packages/roles/persona-en.generated.json`），每条带着
 * **翻译时那份中文的哈希**：
 *
 * - 读职责 / 岗位时（`load.ts`），哈希对得上才把英文补进 `persona.en`；对不上 = 中文改过、
 *   英文还没重出——那就不用它（宁可英文界面显示中文 + 「未翻译」，也不显示一份说的不是同一件事的英文）；
 * - `scripts/gen-persona-en.mjs --check` 只比哈希、不调模型，过期的报出来（CI 里是警告，不卡合并）。
 *
 * 生成脚本本身不在这里（它要联网、要 key），这里只放它与运行时共用的那几样：哈希、读文件、对账。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PersonaSubject, PersonaText } from '@agentsws/contracts'
import { checkGeneratedPersonaEn, personaKey } from './persona.js'

/** 生成产物的位置（随包走，与 `roles/`、`positions/` 同级）。 */
export const PERSONA_EN_FILE = fileURLToPath(
  new URL('../persona-en.generated.json', import.meta.url),
)

/** 一条生成出来的英文。 */
export interface GeneratedPersonaEn {
  /** 翻译时那份中文的哈希（`personaZhHash`）。 */
  zh_hash: string
  en: string
}

/** 产物文件的形状。 */
export interface PersonaEnFile {
  /** 一句给人看的说明（别手改、怎么重出）。 */
  _?: string
  /** `position:<id>` / `role:<id>` → 那一条的英文。 */
  entries: Record<string, GeneratedPersonaEn>
}

/**
 * 中文那份的哈希。先把换行统一成 `\n`、去掉首尾空白——yml 里 `|` 块末尾多一个换行
 * 不该让英文"过期"。取 sha256 的前 16 位：这里防的是"忘了重出"，不是防人伪造。
 */
export function personaZhHash(zh: string): string {
  const normalized = zh.replace(/\r\n?/g, '\n').trim()
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)}`
}

/** persona 的中文那份（老的纯字符串写法里有汉字才算中文；纯英文的老写法不需要翻译）。 */
export function personaZhSource(persona: PersonaText | undefined): string {
  if (persona === undefined) return ''
  if (typeof persona === 'string') return /\p{Script=Han}/u.test(persona) ? persona.trim() : ''
  return (persona.zh ?? '').trim()
}

let cached: { file: string; entries: Map<string, GeneratedPersonaEn> } | undefined

/**
 * 读生成产物。文件没有 / 坏了 → 空表（英文界面回落中文，不让进程起不来）。
 * 读一次缓存住：产物在进程里不会变（重出要重启，同 yml）。
 */
export function loadGeneratedPersonaEn(
  file: string = PERSONA_EN_FILE,
): Map<string, GeneratedPersonaEn> {
  if (cached !== undefined && cached.file === file) return cached.entries
  const entries = new Map<string, GeneratedPersonaEn>()
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersonaEnFile>
      for (const [key, row] of Object.entries(parsed.entries ?? {})) {
        if (typeof row?.zh_hash === 'string' && typeof row.en === 'string')
          entries.set(key, { zh_hash: row.zh_hash, en: row.en })
      }
    } catch {
      // 坏文件当成"还没生成"：英文界面显示中文 + 「未翻译」，进系统提示的中文一个字不受影响
    }
  }
  cached = { file, entries }
  return entries
}

/**
 * 读进来的 persona 补上生成的英文（`load.ts` 读包里的职责 / 岗位时调）。
 *
 * 次序：哈希对得上的生成英文 → yml 里还留着的手写英文（老写法，合并期间可能有）→ 空串。
 * 空串不是错：取英文时回落中文，面板标「未翻译」。
 */
export function withGeneratedEn(
  subject: PersonaSubject,
  persona: PersonaText | undefined,
  generated: ReadonlyMap<string, GeneratedPersonaEn> = loadGeneratedPersonaEn(),
): PersonaText | undefined {
  if (persona === undefined || typeof persona === 'string') return persona
  const zh = (persona.zh ?? '').trim()
  const row = generated.get(personaKey(subject))
  if (zh !== '' && row !== undefined && row.zh_hash === personaZhHash(zh))
    return { zh: persona.zh, en: row.en }
  return { zh: persona.zh ?? '', en: persona.en ?? '' }
}

/** 一条对账结果。 */
export interface PersonaEnProblem {
  key: string
  kind: 'missing' | 'stale' | 'invalid' | 'orphan'
  message: string
}

/**
 * 对账：包里每一段中文 persona，生成产物里有没有、过没过期、合不合格；产物里有没有多出来的。
 *
 * `--check` 与单测共用。只比哈希、不调模型。
 */
export function checkPersonaEn(input: {
  subjects: readonly { subject: PersonaSubject; persona: PersonaText | undefined }[]
  generated: ReadonlyMap<string, GeneratedPersonaEn>
}): PersonaEnProblem[] {
  const out: PersonaEnProblem[] = []
  const seen = new Set<string>()
  for (const { subject, persona } of input.subjects) {
    const zh = personaZhSource(persona)
    if (zh === '') continue
    const key = personaKey(subject)
    seen.add(key)
    const row = input.generated.get(key)
    if (row === undefined) {
      out.push({ key, kind: 'missing', message: '还没有生成英文' })
      continue
    }
    if (row.zh_hash !== personaZhHash(zh)) {
      out.push({ key, kind: 'stale', message: '中文改过了，英文还是按旧的中文翻的（过期）' })
      continue
    }
    const bad = checkGeneratedPersonaEn(row.en)
    if (bad !== undefined) out.push({ key, kind: 'invalid', message: bad })
  }
  for (const key of input.generated.keys())
    if (!seen.has(key))
      out.push({
        key,
        kind: 'orphan',
        message: '包里已经没有这一条（或者它没有中文），产物里多了一条',
      })
  return out.sort((a, b) => a.key.localeCompare(b.key))
}
