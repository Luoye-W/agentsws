/**
 * WP324（决策 690）：配置卡的**内置设置目标**——工具回 `needs_setup` / 建站与开发信的结构化原因时，
 * 卡上要填的那几格、建议值、怎么存。只放「通用的那几样」：选哪家店（建站）、公司实体地址（开发信页脚）。
 * 别的模块要自己的设置卡，用 `SetupCardsAssembly.registerTarget` 登记，不往这里加专属分支。
 */
import type { SetupField } from '@agentsws/contracts'
import { SetupCardError, type SetupTarget } from './setup-cards.js'
import type { SiteThemeAssembly } from './site-theme.js'

export interface BuiltinSetupTargetsOptions {
  theme(): Promise<SiteThemeAssembly | undefined>
  postalAddress(): string | undefined
  setPostalAddress(address: string): boolean
}

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i

export function builtinSetupTargets(options: BuiltinSetupTargetsOptions): SetupTarget[] {
  /** 建站：还不知道是哪家店（WP258：登录后找到几家就给下拉框，官网那家排第一当建议）。 */
  const siteStore: SetupTarget = {
    id: 'site.store',
    name: '店铺地址',
    why: '要知道改哪家店，选好我就接着做。',
    async fields(): Promise<SetupField[]> {
      const r = await (await options.theme())?.readiness().catch(() => undefined)
      const stores = r?.store_lookup?.status === 'ok' ? r.store_lookup.stores : []
      if (stores.length > 0) {
        const site = stores.find((x) => x.store === r?.site_store)
        const first = site ?? stores[0]
        return [
          {
            key: 'store',
            label: '哪家店',
            kind: 'select',
            options: stores.map((x) => ({
              value: x.store,
              label: [x.name, x.store].filter((v) => v !== undefined && v !== '').join(' · '),
            })),
            ...(first === undefined ? {} : { suggested: first.store }),
            ...(site === undefined ? {} : { suggested_why: '品牌档案里官网就是这家' }),
            required: true,
          },
        ]
      }
      return [
        {
          key: 'store',
          label: '店铺地址',
          kind: 'text',
          placeholder: 'xxx.myshopify.com',
          ...(r?.site_store === undefined
            ? {}
            : { suggested: r.site_store, suggested_why: '品牌档案里官网就是这家' }),
          required: true,
        },
      ]
    },
    async satisfied(): Promise<boolean> {
      const r = await (await options.theme())?.readiness().catch(() => undefined)
      return r === undefined || !r.applicable || r.store !== undefined
    },
    async apply(values): Promise<void> {
      const m = await options.theme()
      const store = values.store?.trim().toLowerCase() ?? ''
      if (m === undefined)
        throw new SetupCardError('unknown_target', '这个品牌不是 Shopify 店，用不上。')
      if (!SHOP_DOMAIN.test(store))
        throw new SetupCardError('invalid_input', '店铺地址要是 xxx.myshopify.com 这种。')
      const r = await m.readiness().catch(() => undefined)
      const listed = r?.store_lookup?.stores.some((x) => x.store === store) === true
      try {
        await m.setStore(store, { source: listed ? 'list' : 'manual' })
      } catch (e) {
        throw new SetupCardError('invalid_input', e instanceof Error ? e.message : '没存成')
      }
    },
  }

  /** 开发信：页脚要公司实体地址（法规要求）。真源是公司档案。 */
  const companyAddress: SetupTarget = {
    id: 'company.address',
    name: '公司实体地址',
    why: '每封开发信的页脚都要公司实体地址（法规要求），填好我就接着发。',
    async fields(): Promise<SetupField[]> {
      return [
        {
          key: 'postal_address',
          label: '公司实体地址',
          kind: 'text',
          placeholder: '收得到信的地址，英文信页脚照用',
          required: true,
        },
      ]
    },
    async satisfied(): Promise<boolean> {
      const v = options.postalAddress()?.trim()
      return v !== undefined && v !== ''
    },
    async apply(values): Promise<void> {
      const v = values.postal_address?.trim() ?? ''
      if (v.length < 6) throw new SetupCardError('invalid_input', '地址太短了，写全一点。')
      if (!options.setPostalAddress(v))
        throw new SetupCardError('invalid_input', '公司档案还没建好，先走完开工向导。')
    },
  }

  return [siteStore, companyAddress]
}
