/**
 * WP268（决策 213）：挑中的图**挂到网站**——传店铺「文件」→ 写进主题那一格 → 推未发布预览。
 *
 * 只在人挑中（挑图卡带 `place` = 卡面写明「会传到店铺文件、写进模板、推预览」）之后由 `image-tools.ts` 调。
 * 线上主题一个字节不动：写的是本机主题工作目录，推的是未发布副本（与网页模板 `theme_push_unpublished` 同一条路，
 * 有上一次推过的那一份就推到它上面）。发布照旧只出发布卡。
 *
 * 1. 店铺授权里要有 `write_files`（网页模板那条职责登记了它；老授权没有 → 说一句去岗位页「重新授权」）；
 * 2. 同一张图传过就不再传（`asset.shop_file`，同一家店）；
 * 3. 主题 JSON 里写 `shopify://shop_images/<文件名>`（真店主题文件里就是这样引用店铺文件里的图）；
 *    模板文件顶上 Shopify 自动加的那段 `/* … *\/` 注释原样留着。
 */
import type { DesignAsset, ImagePlaceTarget, RunRequest, WorkspaceId } from '@agentsws/contracts'
import { expandStoreScopes } from '@agentsws/contracts'
import { type BrandAssets, extOfImage } from './brand-assets.js'
import type { PlaceOutcome } from './image-tools.js'
import { placeLabel } from './image-tools.js'
import type { ShopifyAdmin } from './shop-admin.js'
import { type UploadFetch, uploadShopFile } from './shop-files.js'
import type { SiteThemeAssembly } from './site-theme.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

export class ThemePlaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThemePlaceError'
  }
}

/**
 * 把 `value` 写进主题 JSON 的那一格（纯函数）。
 *
 * - `config/settings_data.json`：`current.<setting>`（`current` 是字符串预设名时写不了，照实报）；
 * - 模板 / 分区组：`sections.<section>[.blocks.<b1>.blocks.<b2>…].settings.<setting>`；
 * 找不到那个分区 / 块 → 抛（不凭空建一个分区：类型不知道，建了主题检查会报错）。
 */
export function setThemeImage(text: string, target: ImagePlaceTarget, value: string): string {
  const m = /^\s*(\/\*[\s\S]*?\*\/)\s*/.exec(text)
  const head = m?.[1]
  const body = m === null ? text : text.slice(m[0].length)
  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch {
    throw new ThemePlaceError(`${target.file} 不是合法的 JSON，没法自动写进去。`)
  }
  if (!isObj(doc)) throw new ThemePlaceError(`${target.file} 的内容不对。`)
  let holder: Obj
  if (target.file === 'config/settings_data.json') {
    if (!isObj(doc.current))
      throw new ThemePlaceError('主题设置现在用的是一个预设名，没法单独改这一格。')
    holder = doc.current
  } else {
    const sections = doc.sections
    const sec = isObj(sections) ? sections[target.section ?? ''] : undefined
    if (!isObj(sec))
      throw new ThemePlaceError(`${target.file} 里没有「${target.section ?? ''}」这个分区。`)
    let node: Obj = sec
    for (const key of (target.block ?? '').split('/').filter((k) => k !== '')) {
      const next = isObj(node.blocks) ? node.blocks[key] : undefined
      if (!isObj(next)) throw new ThemePlaceError(`「${target.section}」里没有「${key}」这个块。`)
      node = next
    }
    if (!isObj(node.settings)) node.settings = {}
    holder = node.settings as Obj
  }
  holder[target.setting] = value
  const out = `${JSON.stringify(doc, null, 2)}\n`
  return head === undefined ? out : `${head}\n${out}`
}

export interface ImagePlaceOptions {
  workspace_id: WorkspaceId
  assets: BrandAssets
  clock: { now(): string }
  /** 店铺授权与后台接口（按品牌懒取）。 */
  shop(): Promise<
    | {
        scopes(): Promise<readonly string[] | undefined>
        admin(): Promise<Pick<ShopifyAdmin, 'mutate' | 'query' | 'store'>>
      }
    | undefined
  >
  theme(): Promise<SiteThemeAssembly | undefined>
  /** 传字节到 Shopify 临时地址（测试 / demo 注入；不给用全局 fetch）。 */
  uploadFetch?: UploadFetch
  sleep?: (ms: number) => Promise<void>
}

export function createImagePlacer(options: ImagePlaceOptions) {
  return async (input: {
    asset: DesignAsset
    target: ImagePlaceTarget
    matter_id?: string
    by?: string
  }): Promise<PlaceOutcome> => {
    const { asset, target } = input
    const where = placeLabel(target)
    const shop = await options.shop()
    if (shop === undefined)
      return {
        ok: false,
        message: `图选好了，但这个品牌没连 Shopify 店，没法传上去挂到${where}。图在素材库里。`,
      }
    const scopes = expandStoreScopes([...((await shop.scopes()) ?? [])])
    if (!scopes.includes('write_files'))
      return {
        ok: false,
        message:
          '图选好了，但店铺授权里还没有「上传文件」这一项。到岗位页点「重新授权」补上，再在素材库里点这张图「挂到网站」或让 AI 接着做。',
      }
    let admin: Awaited<ReturnType<typeof shop.admin>>
    try {
      admin = await shop.admin()
    } catch (e) {
      return { ok: false, message: `没连上店铺：${e instanceof Error ? e.message : String(e)}` }
    }
    let file = asset.shop_file?.store === admin.store ? asset.shop_file : undefined
    if (file === undefined) {
      const bytes = await options.assets.bytes(asset.id)
      if (bytes === undefined) return { ok: false, message: '这张图的原图读不到了，没传。' }
      try {
        const up = await uploadShopFile(
          {
            admin,
            fetch: options.uploadFetch ?? ((url, init) => fetch(url, init)),
            ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
          },
          {
            bytes: bytes.bytes,
            content_type: bytes.content_type,
            filename: `agentsws-${asset.id}.${extOfImage(bytes.content_type)}`,
            ...(asset.tags?.[0] === undefined ? {} : { alt: asset.tags[0] }),
          },
        )
        file = { ...up, store: admin.store, uploaded_at: options.clock.now() }
      } catch (e) {
        return { ok: false, message: `图没传到店铺：${e instanceof Error ? e.message : String(e)}` }
      }
      options.assets.update({ ...asset, shop_file: file })
    }
    const theme = await options.theme()
    if (theme === undefined)
      return {
        ok: false,
        message: `图传到店铺「文件」了（${file.filename}），但这个品牌没有主题工坊，没挂上。`,
      }
    try {
      const cur = await theme.readFile(target.file)
      await theme.writeFile(target.file, setThemeImage(cur.content, target, file.theme_ref))
    } catch (e) {
      return {
        ok: false,
        message: `图传到店铺「文件」了（${file.filename}），但没写进${where}：${e instanceof Error ? e.message : String(e)}`,
      }
    }
    const last = (await theme.readiness().catch(() => undefined))?.last_push
    let preview: { theme_id: string; preview_url?: string } | undefined
    try {
      const request = (input.matter_id === undefined
        ? {}
        : { work_item: { id: input.matter_id } }) as unknown as RunRequest
      const pushed = await theme.push({ name: last?.theme_name ?? '首页草稿（配图）', request })
      preview = {
        theme_id: pushed.theme_id,
        ...(pushed.preview_url === undefined ? {} : { preview_url: pushed.preview_url }),
      }
    } catch (e) {
      options.assets.update({
        ...(options.assets.get(asset.id) ?? asset),
        placed: { ...target, at: options.clock.now() },
      })
      return {
        ok: false,
        message: `图已传到店铺、写进${where}，但推预览没成：${e instanceof Error ? e.message : String(e)}。让 AI 再推一次预览就好。`,
      }
    }
    options.assets.update({
      ...(options.assets.get(asset.id) ?? asset),
      placed: { ...target, ...preview, at: options.clock.now() },
    })
    return {
      ok: true,
      message: `挂好了：图传到店铺「文件」（${file.filename}），写进${where}，推了一份新的未发布预览（线上没动）。`,
    }
  }
}
