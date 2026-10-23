/**
 * 教程上官网（私有 docs/113 §4）：右栏「教程」的目录与正文。
 *
 * 本机服务的帮助库挑好用哪一份（官网拉回来存在本机的 / 安装包自带的），这里只是投影。
 * 教程本来就是公开的，**不要岗位、不过策略层**——登录了就能读；不碰任何业务数据。
 * 读目录时顺手让帮助库看看是不是太久没去官网拉了（在后台拉，不等）。
 */
import {
  HELP_KINDS,
  type HelpArticleView,
  type HelpCatalogView,
  type HelpKind,
  type HelpLang,
  type MaybePromise,
} from '@agentsws/contracts'
import { ApiError } from '../errors.js'
import { ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

export interface HelpPort {
  catalog(lang: HelpLang): MaybePromise<HelpCatalogView>
  article(slug: string, lang: HelpLang, kind: HelpKind): MaybePromise<HelpArticleView | undefined>
}

function portOf(deps: GatewayDeps): HelpPort {
  const p = deps.help
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配帮助库（GatewayDeps.help）')
  return p
}

const langOf = (raw: string | undefined): HelpLang => (raw === 'en' ? 'en' : 'zh')

export function helpRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/help/catalog',
        operationId: 'getHelpCatalog',
        summary: '教程上官网：右栏「教程」的目录（每篇已按本机版本挑好用官网的还是随包的）',
        tag: 'workstation',
        auth: 'bearer',
        params: [{ name: 'lang', in: 'query', required: false, description: 'zh（默认）| en' }],
        returns: 'HelpCatalogView',
      },
      async (c, deps) => {
        principalOf(c)
        return ok(c, await portOf(deps).catalog(langOf(c.req.query('lang'))))
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/help/articles/:slug',
        operationId: 'getHelpArticle',
        summary: '教程上官网：一篇的正文（旧名也认）；哪份都没有回 not_found',
        tag: 'workstation',
        auth: 'bearer',
        params: [
          { name: 'slug', in: 'path', required: true, description: '教程 / 笔记的名字' },
          { name: 'lang', in: 'query', required: false, description: 'zh（默认）| en' },
          {
            name: 'kind',
            in: 'query',
            required: false,
            description: 'guide（默认）| note | changelog',
          },
        ],
        returns: 'HelpArticleView',
      },
      async (c, deps) => {
        principalOf(c)
        const rawKind = c.req.query('kind') ?? 'guide'
        if (!(HELP_KINDS as readonly string[]).includes(rawKind))
          throw new ApiError('invalid_input', `kind 只认 ${HELP_KINDS.join(' / ')}`)
        const slug = param(c, 'slug')
        const view = await portOf(deps).article(
          slug,
          langOf(c.req.query('lang')),
          rawKind as HelpKind,
        )
        if (view === undefined) throw new ApiError('not_found', `没有这一篇：${slug}`)
        return ok(c, view)
      },
    ),
  ]
}
