/**
 * WP180：**官方插件管理包一层后打开**——服务进程这一侧的那一层（子路径 `@agentsws/dsh-adapter/official-plugins`）。
 *
 * WP179 判 B 的理由是"装任意第三方代码没有任何人批、装进来的还能改写 profile patch 把 C 类上报打开"。
 * 包的那一层就是三条，全在这个文件里：
 *
 * | 规矩 | 这里怎么做 |
 * |---|---|
 * | 只许从审过的清单装 | `profiles/agentsws/plugin-allowlist.yml`（{@link parsePluginAllowlist} 读，字段一个不对整份拒）；清单外 / 版本对不上 → {@link OfficialPluginError} |
 * | 装 / 升级 / 卸载出卡 | 这里只出"卡上写什么"（{@link cardPayload}）；出卡、批了才做在 `apps/server/src/official-plugins.ts` |
 * | 装完不写回 profile patch | {@link applyChange} 做之前把受保护的文件（锁定 patch）逐字节记下，做完比一遍；变了就原样写回、撤掉这次选择、拒 |
 *
 * **装在哪**：一个 profile 形状的"插件层"目录（`package.json` 的 `dsh.profile.bundles` + 一份空的用户 patch），
 * 用官方 `@deepseek-ai/dsh-app-boot` 的 `initProfile` 建、`readProfileManifest` 读，用官方插件管理的
 * `saveManifest`（`@deepseek-ai/dsh-plugin-manager/operations`，`dsh plugin` 与官方插件管理服务共用的那一份）写。
 * 清单里现在只有 `shipped`（dsh 安装自带、默认关着的官方可选包，上游 `OPTIONAL_BUNDLES`），"装"就是选进来——
 * 与官方插件管理的 `setBundleEnabled` 同一个动作，不下载、不跑 pnpm。选完用官方 `loadProfileDirectory` 真的加载一遍，
 * 被跳过（读不出、dsh 版本不兼容）就撤掉、拒。
 *
 * **这个模块不进运行时的模块图**：主入口不 re-export 它（`profile-lockdown.test.ts` 钉着两档模块图里没有
 * `dsh-plugin-manager`），只有服务进程按子路径 import。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  OfficialPluginAction,
  OfficialPluginCardPayload,
  OfficialPluginSource,
  OfficialPluginSpec,
  OfficialPluginView,
  ProfileConfigWrite,
  ProfileConfigWriteResult,
} from '@agentsws/contracts'
import { isMap, isSeq, parse, parseDocument, type YAMLSeq } from 'yaml'
import { PROFILE_GUARD_ROW } from './profile-guard.js'

/** 被拒的原因码（事件 `official_plugin.rejected` 的 `reason`）。 */
export type OfficialPluginRejectCode =
  | 'not_allowlisted'
  | 'unreviewed_version'
  | 'already_installed'
  | 'not_installed'
  | 'up_to_date'
  | 'source_unsupported'
  | 'not_shipped'
  | 'patch_changed'
  | 'load_failed'

export class OfficialPluginError extends Error {
  constructor(
    readonly code: OfficialPluginRejectCode,
    message: string,
  ) {
    super(message)
    this.name = 'OfficialPluginError'
  }
}

/** 我们这个场景（agentsws profile）自己的两层 bundle；插件层选进来的排在它们后面。 */
export const AGENTSWS_BASE_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-headless',
]

const REPO_PROFILE = new URL('../../../profiles/agentsws/', import.meta.url)

/** 仓库里那份审过的清单（`profiles/agentsws/plugin-allowlist.yml`）。 */
export function defaultAllowlistPath(): string {
  return fileURLToPath(new URL('plugin-allowlist.yml', REPO_PROFILE))
}

/** 仓库里那份锁定 patch（`profiles/agentsws/cordis.patch.yml`）——装插件时要逐字节不变的那一份。 */
export function defaultProfilePatchPath(): string {
  return fileURLToPath(new URL('cordis.patch.yml', REPO_PROFILE))
}

const SOURCES: readonly OfficialPluginSource[] = ['shipped', 'npm']
const NAME = /^@deepseek-ai\/[a-z0-9][a-z0-9._-]*$/
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`清单：${what} 必须是非空字符串`)
  return v
}

function strList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) {
    throw new Error(`清单：${what} 必须是字符串数组`)
  }
  return [...(v as string[])]
}

/**
 * 读审过的清单。**字段一个不对整份拒**（fail closed）：包名只认 `@deepseek-ai/…`、版本只认写死的
 * （不许范围）、来源只认两种、许可证 / 工具 / 出网 / 插入的行都得写。重名也拒。
 */
export function parsePluginAllowlist(text: string): OfficialPluginSpec[] {
  const raw = parse(text) as unknown
  if (!Array.isArray(raw)) throw new Error('清单：顶层必须是列表')
  const out: OfficialPluginSpec[] = []
  for (const [i, item] of raw.entries()) {
    if (item === null || typeof item !== 'object') throw new Error(`清单：第 ${i + 1} 项不是对象`)
    const r = item as Record<string, unknown>
    const name = str(r.name, `第 ${i + 1} 项 name`)
    if (!NAME.test(name)) throw new Error(`清单：${name} 不是官方包名（@deepseek-ai/…）`)
    const version = str(r.version, `${name} version`)
    if (!EXACT.test(version)) throw new Error(`清单：${name} 的版本必须写死（${version}）`)
    const source = r.source as OfficialPluginSource
    if (!SOURCES.includes(source)) throw new Error(`清单：${name} 的 source 只能是 shipped / npm`)
    if (typeof r.network !== 'boolean')
      throw new Error(`清单：${name} 的 network 必须写 true / false`)
    const note = r.network_note
    if (r.network && (typeof note !== 'string' || note.trim() === '')) {
      throw new Error(`清单：${name} 会出网，network_note 必须写清发到哪、发什么`)
    }
    if (out.some((o) => o.name === name)) throw new Error(`清单：${name} 重复`)
    out.push({
      name,
      version,
      source,
      license: str(r.license, `${name} license`),
      title: str(r.title, `${name} title`),
      summary: str(r.summary, `${name} summary`),
      tools: strList(r.tools ?? [], `${name} tools`),
      network: r.network,
      ...(typeof note === 'string' && note.trim() !== '' ? { network_note: note } : {}),
      rows: strList(r.rows, `${name} rows`),
    })
  }
  return out
}

/** 从文件读清单；读不到 / 读歪都抛（调用方据此把整页标成"装不了"）。 */
export function readPluginAllowlist(path = defaultAllowlistPath()): OfficialPluginSpec[] {
  return parsePluginAllowlist(readFileSync(path, 'utf8'))
}

// ── 插件层（profile 形状的目录）─────────────────────────────────────────────

/**
 * 插件层的读写口。缺省实现 {@link shippedBundleBackend} 全用官方模块；测试可以换一个假的
 * （比如"装的时候顺手改了 patch"的坏后端，用来钉 {@link applyChange} 那道比对）。
 */
export interface OfficialPluginBackend {
  /** 批过、记在层里的：包名 → 当时审过的版本。 */
  approved(): Record<string, string>
  /** dsh 安装里带的这个包的版本（不是 dsh 自带的可选包 → `undefined`）。 */
  shippedVersion(name: string): string | undefined
  /** 选进来（装 / 升级）：写层里的 bundle 列表与审过的版本。 */
  select(name: string, version: string): Promise<void>
  /** 撤掉（卸载）。 */
  deselect(name: string): Promise<void>
  /** 用官方加载器真的加载一遍层，回这些包里被跳过的（读不出 / 不兼容）。 */
  skipped(names: readonly string[]): Promise<string[]>
  /** 层目录（给完整 profile 起的时候用）。 */
  readonly dir: string
}

/** 层的 `package.json` 里我们自己记的那一块（官方字段一个不动）。 */
interface LayerManifest {
  dsh?: { profile?: { bundles?: string[] } & Record<string, unknown> } & Record<string, unknown>
  agentsws?: { approved?: Record<string, string> }
  [k: string]: unknown
}

type AppBoot = typeof import('@deepseek-ai/dsh-app-boot')
type Operations = typeof import('@deepseek-ai/dsh-plugin-manager/operations')

/** `@deepseek-ai/dsh/package.json` 的绝对路径——官方 `resolveBundleDir` 的"安装锚点"。 */
export function dshInstallAnchor(): string {
  return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
}

/**
 * 缺省后端：dsh 安装自带的官方可选包（上游 `OPTIONAL_BUNDLES`）。建层、读写层、加载层全用官方的。
 * `dir` 不存在就用官方 `initProfile` 建（bundle 列表 = 我们那两层）。
 */
export async function shippedBundleBackend(input: {
  dir: string
  installAnchor?: string
}): Promise<OfficialPluginBackend> {
  const boot: AppBoot = await import('@deepseek-ai/dsh-app-boot')
  const ops: Operations = await import('@deepseek-ai/dsh-plugin-manager/operations')
  const { dir } = input
  const anchor = input.installAnchor ?? dshInstallAnchor()
  boot.initProfile(dir, AGENTSWS_BASE_BUNDLES)
  const read = (): LayerManifest => boot.readProfileManifest('dsh', dir) as LayerManifest
  const write = (m: LayerManifest): Promise<void> =>
    ops.saveManifest(dir, m as Parameters<Operations['saveManifest']>[1])
  const bundlesOf = (m: LayerManifest): string[] => [
    ...(m.dsh?.profile?.bundles ?? AGENTSWS_BASE_BUNDLES),
  ]
  const withLayer = (m: LayerManifest, bundles: string[], approved: Record<string, string>) => ({
    ...m,
    dsh: { ...m.dsh, profile: { ...m.dsh?.profile, bundles } },
    agentsws: { ...m.agentsws, approved },
  })
  return {
    dir,
    approved: () => ({ ...(read().agentsws?.approved ?? {}) }),
    shippedVersion(name) {
      if (!boot.OPTIONAL_BUNDLES.includes(name)) return undefined
      try {
        const pkgDir = boot.resolveBundleDir('dsh', name, anchor, dir)
        const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
          version?: unknown
        }
        return typeof pkg.version === 'string' ? pkg.version : undefined
      } catch {
        return undefined
      }
    },
    async select(name, version) {
      const m = read()
      const bundles = bundlesOf(m).filter((b) => b !== name)
      bundles.push(name)
      await write(withLayer(m, bundles, { ...(m.agentsws?.approved ?? {}), [name]: version }))
    },
    async deselect(name) {
      const m = read()
      const approved = { ...(m.agentsws?.approved ?? {}) }
      delete approved[name]
      await write(
        withLayer(
          m,
          bundlesOf(m).filter((b) => b !== name),
          approved,
        ),
      )
    },
    async skipped(names) {
      const loaded = boot.loadProfileDirectory('dsh', dir, anchor, { userLayer: false })
      const got = new Set(loaded.layers.map((l) => l.packageName))
      return names.filter((n) => !got.has(n))
    },
  }
}

// ── 状态、计划、执行 ─────────────────────────────────────────────────────────

/** 一项在这台机器上的样子（不含"有没有卡在等"——那是服务进程知道的事）。 */
export function pluginView(
  spec: OfficialPluginSpec,
  backend: OfficialPluginBackend,
): OfficialPluginView {
  const installed = backend.approved()[spec.name]
  const shipped = spec.source === 'shipped' ? backend.shippedVersion(spec.name) : undefined
  const base = {
    ...spec,
    ...(installed === undefined ? {} : { installed_version: installed }),
    ...(shipped === undefined ? {} : { available_version: shipped }),
  }
  // 安装里带的不是审过的那个版本（dsh 升级了、清单没重审）：装不了，装着的也不进组合
  if (spec.source === 'shipped' && shipped !== spec.version) return { ...base, state: 'unreviewed' }
  if (installed === undefined) return { ...base, state: 'available' }
  return { ...base, state: installed === spec.version ? 'installed' : 'upgradable' }
}

/** 一次变动的计划：装成哪个版本、从哪个版本升。 */
export interface OfficialPluginPlan {
  action: OfficialPluginAction
  spec: OfficialPluginSpec
  version: string
  from_version?: string
}

/**
 * 出卡之前、批了之后**各查一遍**：清单里有没有、版本审没审过、这个动作现在说得通吗。
 * 说不通就抛 {@link OfficialPluginError}（原因码进 `official_plugin.rejected`）。
 */
export function planChange(input: {
  action: OfficialPluginAction
  name: string
  allowlist: readonly OfficialPluginSpec[]
  backend: OfficialPluginBackend
}): OfficialPluginPlan {
  const { action, name, backend } = input
  const spec = input.allowlist.find((s) => s.name === name)
  if (spec === undefined) {
    throw new OfficialPluginError('not_allowlisted', `${name} 不在审过的清单里，不能装`)
  }
  if (spec.source !== 'shipped') {
    throw new OfficialPluginError(
      'source_unsupported',
      `${name}：npm 来源的官方包这一版还不装（只装 dsh 自带的可选包）`,
    )
  }
  const view = pluginView(spec, backend)
  const installed = view.installed_version
  if (action === 'uninstall') {
    if (installed === undefined)
      throw new OfficialPluginError('not_installed', `${spec.title} 没装`)
    return { action, spec, version: installed }
  }
  if (view.available_version === undefined) {
    throw new OfficialPluginError('not_shipped', `这份 dsh 里没有 ${name}（不是它自带的可选包）`)
  }
  if (view.state === 'unreviewed') {
    throw new OfficialPluginError(
      'unreviewed_version',
      `${spec.title}：dsh 里带的是 ${view.available_version}，清单审过的是 ${spec.version}，要先重审清单`,
    )
  }
  if (action === 'install') {
    if (installed !== undefined)
      throw new OfficialPluginError('already_installed', `${spec.title} 已经装了`)
    return { action, spec, version: spec.version }
  }
  if (installed === undefined)
    throw new OfficialPluginError('not_installed', `${spec.title} 没装，不能升级`)
  if (installed === spec.version)
    throw new OfficialPluginError('up_to_date', `${spec.title} 已经是审过的最新版`)
  return { action, spec, version: spec.version, from_version: installed }
}

/** 卡上写什么（`official_plugin` 卡的 payload）。 */
export function cardPayload(plan: OfficialPluginPlan): OfficialPluginCardPayload {
  const { spec } = plan
  return {
    action: plan.action,
    name: spec.name,
    title: spec.title,
    version: plan.version,
    ...(plan.from_version === undefined ? {} : { from_version: plan.from_version }),
    source: spec.source,
    license: spec.license,
    tools: [...spec.tools],
    network: spec.network,
    ...(spec.network_note === undefined ? {} : { network_note: spec.network_note }),
  }
}

/**
 * 照计划做一次（卡批了之后调）。**做之前把 `protectedFiles`（锁定 patch）逐字节记下，做完比一遍**：
 * 变了就原样写回、撤掉这次选择、抛 `patch_changed`——装插件永远不许改到锁定表。
 * 选进来之后用官方加载器真的加载一遍，被跳过就撤掉、抛 `load_failed`。
 */
export async function applyChange(input: {
  plan: OfficialPluginPlan
  backend: OfficialPluginBackend
  protectedFiles: readonly string[]
}): Promise<void> {
  const { plan, backend } = input
  const before = input.protectedFiles.map((f) => ({
    f,
    bytes: existsSync(f) ? readFileSync(f) : undefined,
  }))
  const previous = backend.approved()[plan.spec.name]
  const undo = async (): Promise<void> => {
    if (previous === undefined) await backend.deselect(plan.spec.name)
    else await backend.select(plan.spec.name, previous)
  }
  if (plan.action === 'uninstall') await backend.deselect(plan.spec.name)
  else await backend.select(plan.spec.name, plan.version)
  const changed = before.filter(({ f, bytes }) => {
    const now = existsSync(f) ? readFileSync(f) : undefined
    return bytes === undefined ? now !== undefined : now === undefined || !now.equals(bytes)
  })
  if (changed.length > 0) {
    for (const { f, bytes } of changed) if (bytes !== undefined) writeFileSync(f, bytes)
    await undo()
    throw new OfficialPluginError(
      'patch_changed',
      `这次变动改到了锁定的 profile patch（${changed.map((c) => c.f).join('、')}），已原样恢复、没装`,
    )
  }
  if (plan.action !== 'uninstall') {
    const skipped = await backend.skipped([plan.spec.name])
    if (skipped.length > 0) {
      await undo()
      throw new OfficialPluginError(
        'load_failed',
        `${plan.spec.title} 加载不起来（读不出或与这份 dsh 不兼容），已撤掉`,
      )
    }
  }
}

/**
 * 完整 profile 起的时候该选哪些 bundle：我们那两层 + 批过**且版本仍是审过的那个**的可选包。
 * 版本对不上的（`unreviewed`）不进组合——清单重审之前它不跑。
 */
export function effectiveBundles(
  allowlist: readonly OfficialPluginSpec[],
  backend: OfficialPluginBackend,
): string[] {
  const on = allowlist
    .map((spec) => pluginView(spec, backend))
    .filter((v) => v.state === 'installed')
    .map((v) => v.name)
  return [...AGENTSWS_BASE_BUNDLES, ...on]
}

// ── 配置写回（只许写不在锁定表里的行）───────────────────────────────────────

/**
 * 锁定表：我们那份 profile patch 里出现的每一个 id（锁定行 + 插进来写死关的行），再加守门插件自己那一行。
 * 从文件现读，不另抄一份——锁定表改了，这里跟着改。
 */
export function lockedRowIds(patchText: string): string[] {
  const rows = parse(patchText, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (src: string) => ({ js: src }) }],
  }) as unknown
  const out = new Set<string>([PROFILE_GUARD_ROW])
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const row of list) {
      if (row === null || typeof row !== 'object') continue
      const r = row as { id?: unknown; insert?: unknown }
      if (typeof r.id === 'string') out.add(r.id)
      visit(r.insert)
    }
  }
  visit(rows)
  return [...out].sort()
}

/**
 * 一次配置保存能不能写：锁定表里的行一律拒（`locked_row`）；给了"组合里有哪些行"就再查一遍认不认得（`unknown_row`）；
 * 值必须是普通对象，而且不许借配置改 `disabled` / `name` / `insert`（`invalid_config`）。
 */
export function checkConfigWrite(
  write: ProfileConfigWrite,
  opts: { locked: readonly string[]; known?: readonly string[] },
): ProfileConfigWriteResult {
  const { row_id } = write
  if (opts.locked.includes(row_id)) {
    return {
      ok: false,
      row_id,
      reason: 'locked_row',
      message: `${row_id} 在锁定表里（要人拍板的那几行），运行中的保存改不动它`,
    }
  }
  if (opts.known !== undefined && !opts.known.includes(row_id)) {
    return { ok: false, row_id, reason: 'unknown_row', message: `组合里没有 ${row_id} 这一行` }
  }
  const c = write.config as unknown
  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    return { ok: false, row_id, reason: 'invalid_config', message: '配置必须是一个对象' }
  }
  return { ok: true, row_id }
}

/**
 * 写回插件层的用户 patch（**不是**锁定 patch）：找到这一行的覆盖就改它的 `config`，没有就加一行
 * `- id: <行> / config: …`。只写 `config`，不写 `disabled` / `name` / `insert`。先过 {@link checkConfigWrite}。
 * 完整 profile 起的时候锁定 patch 叠在它**后面**（优先级更高），所以就算有人手改了这份文件也盖不过锁定表。
 */
export function writeLayerConfig(input: {
  layerPatch: string
  write: ProfileConfigWrite
  locked: readonly string[]
  known?: readonly string[]
}): ProfileConfigWriteResult {
  const verdict = checkConfigWrite(input.write, {
    locked: input.locked,
    ...(input.known === undefined ? {} : { known: input.known }),
  })
  if (!verdict.ok) return verdict
  const text = existsSync(input.layerPatch) ? readFileSync(input.layerPatch, 'utf8') : ''
  const doc = parseDocument(text)
  if (!isSeq(doc.contents)) doc.contents = doc.createNode([]) as typeof doc.contents
  const seq = doc.contents as YAMLSeq
  const hit = seq.items.find((item) => isMap(item) && item.get('id') === input.write.row_id)
  if (isMap(hit)) hit.set('config', doc.createNode(input.write.config))
  else seq.add(doc.createNode({ id: input.write.row_id, config: input.write.config }))
  writeFileSync(input.layerPatch, String(doc))
  return verdict
}

/** 插件层的用户 patch 在哪（官方 `initProfile` 建的那一份）。 */
export function layerPatchPath(dir: string): string {
  return join(dir, 'cordis.patch.yml')
}
