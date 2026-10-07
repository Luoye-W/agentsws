/**
 * WP253：Run 里的**受限主题工具**真接上（九个名字在 `@agentsws/stand-ins` 的 `runtime/theme.ts`）。
 *
 * 这里一行业务逻辑都没有，只做四件事（照 `b2b-outbound-tools.ts`）：
 *
 * 1. **判职责**：只有网页模板（`site.shopify-theme` / 旧名 `site.builder`）能用，别的一律 `blocked`；
 * 2. **发布永远不在这里发**：`theme_publish` 只出 `publish_theme` 的审批卡（人批了执行器才调 `theme publish`）；
 * 3. **还差哪一步说人话**：没装 CLI / 没登录 / 不知道店铺 → 一句「去岗位页点哪个按钮」+ `needs`，不甩英文报错；
 * 4. 回的数据是白名单：路径、名字、数字、预览链接；没有令牌、没有 CLI 原文（原文已经抹过、只在出错时带一段）。
 */
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import {
  isThemeRole,
  THEME_CHECK_TOOL,
  THEME_FILES_TOOL,
  THEME_INIT_TOOL,
  THEME_LIST_TOOL,
  THEME_PUBLISH_TOOL,
  THEME_PULL_TOOL,
  THEME_PUSH_TOOL,
  THEME_READ_FILE_TOOL,
  THEME_TOOL_NAMES,
  THEME_WRITE_FILE_TOOL,
} from '@agentsws/stand-ins'
import { type SiteThemeAssembly, SiteThemeError } from './site-theme.js'
import { themeReadPage } from './theme-read.js'

export interface ThemeToolsOptions {
  /** 这个品牌的主题工坊（懒取：比运行时晚建出来）。 */
  module(): Promise<SiteThemeAssembly | undefined>
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

export function createThemeToolExecutor(options: ThemeToolsOptions): ToolExecutor {
  return async ({ name, input, request }): Promise<ToolExecution> => {
    const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
    if (!THEME_TOOL_NAMES.includes(bare))
      return { status: 'error', reason: `not_a_theme_tool:${bare}` }
    if (!isThemeRole(request.actor.role_id))
      return {
        status: 'blocked',
        reason: `${request.actor.role_id} 不是「Shopify 网页模板」职责，用不了主题工具。`,
      }
    const m = await options.module()
    if (m === undefined)
      return { status: 'error', reason: '这个进程没装主题工坊，主题工具用不了。' }
    try {
      switch (bare) {
        case THEME_INIT_TOOL: {
          const out = await m.initFromBase({ replace: input.replace === true })
          return { status: 'ok', data: { ok: true, ...out } }
        }
        case THEME_LIST_TOOL: {
          const themes = await m.list()
          return {
            status: 'ok',
            data: {
              themes: themes.map((t) => ({
                id: t.id,
                name: t.name,
                role: t.role,
                ...(t.preview_url === undefined ? {} : { preview_url: t.preview_url }),
              })),
            },
          }
        }
        case THEME_PULL_TOOL: {
          const theme_id = str(input.theme_id)
          return { status: 'ok', data: await m.pull(theme_id === undefined ? {} : { theme_id }) }
        }
        case THEME_CHECK_TOOL: {
          const r = await m.check()
          return {
            status: 'ok',
            data: { errors: r.errors, warnings: r.warnings, offenses: r.offenses.slice(0, 50) },
          }
        }
        case THEME_FILES_TOOL:
          return { status: 'ok', data: await m.files(str(input.dir)) }
        case THEME_READ_FILE_TOOL: {
          const path = str(input.path)
          if (path === undefined)
            return { status: 'error', reason: '要给 path（工作目录里的相对路径）。' }
          // WP260：长文件分页、CATALOG.json 给目录页 / 按 ids 挑（见 `theme-read.ts`）
          return { status: 'ok', data: themeReadPage(await m.readFile(path), input) }
        }
        case THEME_WRITE_FILE_TOOL: {
          const path = str(input.path)
          if (path === undefined)
            return { status: 'error', reason: '要给 path（工作目录里的相对路径）。' }
          if (typeof input.content !== 'string')
            return { status: 'error', reason: '要给 content（文件的完整新内容）。' }
          return { status: 'ok', data: await m.writeFile(path, input.content) }
        }
        case THEME_PUSH_TOOL: {
          const nameIn = str(input.name)
          if (nameIn === undefined)
            return { status: 'error', reason: '要给 name（这份副本叫什么）。' }
          const r = await m.push({ name: nameIn, request })
          return {
            status: 'ok',
            data: {
              theme_id: r.theme_id,
              theme_name: r.theme_name,
              ...(r.preview_url === undefined ? {} : { preview_url: r.preview_url }),
              changed_files: r.changed_files,
              unpublished: true,
            },
          }
        }
        case THEME_PUBLISH_TOOL: {
          const theme_id = str(input.theme_id)
          if (theme_id === undefined)
            return { status: 'error', reason: '要给 theme_id（推上去的那份副本的 id）。' }
          const r = await m.proposePublish({ theme_id, request })
          return { status: 'ok', data: { ...r, kind: 'publish_theme' } }
        }
        default:
          return { status: 'error', reason: `not_a_theme_tool:${bare}` }
      }
    } catch (e) {
      if (e instanceof SiteThemeError)
        return {
          status: e.code === 'outside' ? 'blocked' : 'error',
          reason: e.message,
          ...(e.need === undefined ? {} : { data: { needs: e.need } }),
        }
      return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
    }
  }
}
