/**
 * WP119（68 / 48 §5）：**浏览器插件的本机那一半**。
 *
 * 插件报一批观测过来，这里做三件事，顺序不能反：
 *
 * 1. **先落本机**。找到或新建 `creator` + `platform_account`，把这一刻的粉丝数
 *    与 `observed_at` 写下去。这一步永远发生——云连不上、没登录、令牌过期，
 *    用户按下的那一下也必须留在他自己的电脑上。
 * 2. **再转发**。登录了云账号就把同一批（**过一遍更窄的白名单**）送去公共红人库。
 *    转发失败不回滚第 1 步，也不让整个请求失败——公共库是加分项，不是先决条件。
 * 3. **联系方式单走一条**。明文进本机加密库，库里只留 `value_ref`。
 *    这个文件里没有任何一处把明文放进返回值、日志或事件。
 *
 * Luoye 09-19 定的那一条落在第 2 步：**只要登录了云账号就默认共享，不设勾选项**。
 * 所以这里没有 `if (settings.contribute)` 这种分支——有的只是 `linked()`。
 * 对应的义务是「说清楚」，那一半在插件的隐私页、面板第一行与 `STORE.md` 里。
 *
 * **不经审批卡**：用户在页面上按的那一下就是决定本身（36「只有要人拍板的才是卡」）。
 * 把「我看到了这个人」做成一张待批的卡，等于让用户为自己刚做的动作再点一次同意。
 */

import type {
  ExtensionHello,
  ExtensionIngestResult,
  ExtensionIngestRow,
  ExtensionObservation,
  ExtensionPort,
  ExtensionStore,
} from '@agentsws/api'
import type { Clock, Creator, KolChannel, PlatformAccount, WorkspaceId } from '@agentsws/contracts'
import type { KolStore } from './kol.js'
import { CONTACT_SECRET_FIELD, contactSecretId } from './kol-service.js'
import type { SecretStore } from './secret-store.js'

/**
 * 往公共红人库转发的那一跳。
 *
 * 形状刻意**只有两个方法**：连着没有、送一批。它既不读库、也不花积分——
 * 贡献与奖励照旧免费（49 M4，WP126 口径③保留）；官方侧的浏览 / reveal 计费改造不经插件这条路。
 */
export interface PublicLibraryContributor {
  linked(): boolean
  contribute(rows: readonly PublicObservationRow[]): Promise<{ accepted: number }>
}

/**
 * 送去公共库的一行。**比插件报上来的那条还窄**。
 *
 * 少掉的几格是故意的：`bio` 是红人自己写的文案（可能有版权、也可能是私人信息），
 * `avatar_url` 与 `page_url` 里带平台的一次性参数。公共库要的是
 * 「谁、在哪条渠道、有多少粉、什么时候看到的」，别的一概不要。
 */
export interface PublicObservationRow {
  channel: KolChannel
  handle: string
  /** 页面上原样那串。**不送解析出来的数** —— 解析错一条就污染所有人的库。 */
  followers_text?: string | undefined
  followers?: number | undefined
  observed_at: string
  /** 公开的商务邮箱与它的来源页（用户显式收下过才有）。 */
  contact?: { value: string; source?: string | undefined } | undefined
}

export interface ExtensionServiceOptions {
  workspace_id: WorkspaceId
  workspaceName: () => string
  store: ExtensionStore
  kol: KolStore
  /** 这个品牌那一段加密库。联系方式明文只经过它。 */
  secrets: SecretStore
  clock: Clock
  random(): number
  /** 不给 = 这台机器没关联云账号，一条都不往外送。 */
  publicLibrary?: PublicLibraryContributor | undefined
  serverVersion: string
}

/** 把 handle 归一成一个能当键用的东西（`@Foo` 与 `foo` 是同一个人）。 */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase()
}

/** 渠道 + handle → 主页地址（库里只存渠道与 handle，链接是拼出来的）。 */
function urlOf(channel: KolChannel, handle: string): string {
  const bare = normalizeHandle(handle)
  switch (channel) {
    case 'youtube':
      return `https://www.youtube.com/@${bare}`
    case 'instagram':
      return `https://www.instagram.com/${bare}`
    case 'tiktok':
      return `https://www.tiktok.com/@${bare}`
    case 'facebook':
      return `https://www.facebook.com/${bare}`
    default:
      return `https://x.com/${bare}`
  }
}

export function createExtensionService(options: ExtensionServiceOptions): ExtensionPort {
  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  /**
   * 找到或新建「这条渠道上的这个 handle」。
   *
   * 找的时候按**归一化的 handle**比：`@Foo` / `foo` / `@foo` 是同一个人，
   * 不归一就会在库里堆出三条一样的记录，而用户完全不知道为什么。
   */
  function upsert(one: ExtensionObservation): { creator: Creator; account: PlatformAccount } {
    const key = normalizeHandle(one.handle)
    const existing = options.kol
      .accounts({ channel: one.channel })
      .find((a) => normalizeHandle(a.handle) === key)

    if (existing !== undefined) {
      const creator =
        options.kol.creator(existing.creator_id) ??
        ({
          id: existing.creator_id,
          display_name: one.display_name ?? one.handle,
          merged_from: [],
        } as Creator)
      // 名字**只在原来那个空着的时候**补——用户可能在工作台里改过显示名，
      // 页面上抓来的那个不该把它盖掉。
      if (creator.display_name === '' && one.display_name !== undefined) {
        options.kol.saveCreator({ ...creator, display_name: one.display_name })
      }
      const account: PlatformAccount = {
        ...existing,
        ...(one.followers === undefined ? {} : { followers: one.followers }),
        ...(one.country === undefined ? {} : { region: one.country }),
        observed_at: one.observed_at,
      }
      options.kol.saveAccount(account)
      return { creator, account }
    }

    const creator: Creator = {
      id: nextId('cr'),
      display_name: one.display_name ?? one.handle,
      merged_from: [],
    }
    options.kol.saveCreator(creator)
    const account: PlatformAccount = {
      id: nextId('pa'),
      creator_id: creator.id,
      channel: one.channel,
      handle: one.handle,
      url: one.url ?? urlOf(one.channel, one.handle),
      ...(one.followers === undefined ? {} : { followers: one.followers }),
      ...(one.country === undefined ? {} : { region: one.country }),
      observed_at: one.observed_at,
    }
    options.kol.saveAccount(account)
    return { creator, account }
  }

  /**
   * 收下一个联系方式。**明文进加密库，库里只留 key 名。**
   *
   * 加密库没开时不降级成明文——存不了就不存，并在回执里说一句。
   * 「先存着回头再加密」这种做法比不存危险得多。
   */
  function saveContact(creator_id: string, one: ExtensionObservation): string | undefined {
    const contact = one.contact
    if (contact === undefined) return undefined
    if (contact.kind === 'phone') return '这一版只收邮箱 / 私信 / 合作表单三种'
    const already = options.kol.contacts(creator_id)
    if (already.length > 0) return undefined
    if (!options.secrets.available) return '这台机器的加密库没开，联系方式没存下来'
    const id = nextId('cc')
    options.secrets.put(contactSecretId(id), { [CONTACT_SECRET_FIELD]: contact.value })
    options.kol.saveContact({
      id,
      creator_id,
      kind: contact.kind,
      value_ref: contactSecretId(id),
      source: contact.source ?? 'extension',
    })
    return undefined
  }

  return {
    store: options.store,

    hello: (): ExtensionHello => {
      const linked = options.publicLibrary?.linked() === true
      return {
        workspace_id: options.workspace_id,
        workspace_name: options.workspaceName(),
        cloud_linked: linked,
        // 登录了就共享，**没有第二个开关**（Luoye 09-19）。
        shares_to_public_library: linked,
        scopes: ['kol.observe', 'kol.capture', 'kol.read'],
        server_version: options.serverVersion,
      }
    },

    ingest: async (session, input): Promise<ExtensionIngestResult> => {
      const rows: ExtensionIngestRow[] = []
      const forwardable: PublicObservationRow[] = []

      for (const one of input.observations) {
        if (normalizeHandle(one.handle) === '') {
          rows.push({ handle: one.handle, status: 'invalid', reason: '没有 handle' })
          continue
        }
        const before = options.kol
          .accounts({ channel: one.channel })
          .some((a) => normalizeHandle(a.handle) === normalizeHandle(one.handle))
        const { creator } = upsert(one)
        const contactNote = saveContact(creator.id, one)
        rows.push({
          handle: one.handle,
          // 本来就有 = `deduped`。**它不是失败**：库里那条的数字已经被这一次刷新了。
          status: before ? 'deduped' : 'ok',
          creator_id: creator.id,
          ...(contactNote === undefined ? {} : { reason: contactNote }),
        })
        forwardable.push({
          channel: one.channel,
          handle: one.handle,
          ...(one.followers_text === undefined ? {} : { followers_text: one.followers_text }),
          ...(one.followers === undefined ? {} : { followers: one.followers }),
          observed_at: one.observed_at,
          ...(one.contact === undefined || one.contact.kind !== 'email'
            ? {}
            : {
                contact: {
                  value: one.contact.value,
                  ...(one.contact.source === undefined ? {} : { source: one.contact.source }),
                },
              }),
        })
      }

      // 没登录 = 一条都不出这台电脑。这是 `linked()` 唯一的用处。
      const cloud = options.publicLibrary
      if (cloud === undefined || !cloud.linked() || forwardable.length === 0) {
        void session
        return { rows, forwarded_to_public_library: 0 }
      }
      try {
        const out = await cloud.contribute(forwardable)
        return { rows, forwarded_to_public_library: out.accepted }
      } catch {
        // 云那一跳挂了不影响本机那一半：数据已经在用户自己的电脑上了。
        // 回执里如实报 0，插件卡片上就不会说"共享了几条"。
        return { rows, forwarded_to_public_library: 0 }
      }
    },
  }
}
