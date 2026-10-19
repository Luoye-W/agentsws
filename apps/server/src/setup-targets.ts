/**
 * WP324（决策 690）：配置卡的**内置设置目标**——工具回 `needs_setup` / 建站与开发信的结构化原因时，
 * 卡上要填的那几格、建议值、怎么存。只放「通用的那几样」：选哪家店（建站）、公司实体地址（开发信页脚）。
 * 别的模块要自己的设置卡，用 `SetupCardsAssembly.registerTarget` 登记，不往这里加专属分支。
 */
import type { SetupField } from '@agentsws/contracts'
import { SetupCardError, type SetupTarget } from './setup-cards.js'
import {
  DEFAULT_SOURCE,
  fencedHits,
  hitContaining,
  jsonOf,
  MODEL_SOURCE,
  profileSource,
  type SetupPlan,
  webSource,
} from './setup-research.js'
import type { SiteThemeAssembly } from './site-theme.js'

export interface BuiltinSetupTargetsOptions {
  theme(): Promise<SiteThemeAssembly | undefined>
  postalAddress(): string | undefined
  setPostalAddress(address: string): boolean
  /**
   * WP334（决策 726）：公司档案里给 AI 干活用的那几格（一句话介绍 / 客服邮箱 / 币种）。
   * 不给 = 不登记「公司档案」这个目标（老装配）。
   */
  brandFacts?(): { one_liner?: string; support_email?: string; currency?: string }
  /** 存那几格（不给的不动）；档案还没建过回 `false`。 */
  setBrandFacts?(facts: { one_liner?: string; support_email?: string; currency?: string }): boolean
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY', 'HKD']
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i

/** WP348：目标市场 → 币种（查不到按 USD 起步，人改）。 */
const CURRENCY_BY_MARKET: Readonly<Record<string, string>> = {
  US: 'USD',
  GB: 'GBP',
  UK: 'GBP',
  CA: 'CAD',
  AU: 'AUD',
  JP: 'JPY',
  CN: 'CNY',
  HK: 'HKD',
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  NL: 'EUR',
  IE: 'EUR',
  AT: 'EUR',
  BE: 'EUR',
  FI: 'EUR',
  PT: 'EUR',
  EU: 'EUR',
}

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
    // WP348：查什么——Shopify 登录后看得到的店（已连的数据）、官网里读到的店铺地址（档案）
    async research(kit): Promise<SetupPlan> {
      const r = await (await options.theme())?.readiness().catch(() => undefined)
      const stores = r?.store_lookup?.status === 'ok' ? r.store_lookup.stores : []
      if (stores.length > 0)
        kit.note(`Shopify 登录后看得到 ${stores.length} 家店`, {
          kind: 'connected',
          label: 'Shopify 登录',
        })
      if (r?.site_store !== undefined)
        kit.note(`官网里读到的店：${r.site_store}`, profileSource('官网'))
      if (stores.length === 0 && r?.site_store === undefined)
        kit.note('登录后没看到店、官网里也没读到店铺地址')
      return {}
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
    // WP348：查什么——官网 / 联网搜到的联系页里写着的地址（模型只摘原文，核对过才用）；查不到要你填
    async research(kit): Promise<SetupPlan> {
      const facts = await kit.profile()
      const who = facts.domain ?? facts.name
      if (who === undefined) {
        kit.note('档案里没有官网，没法查地址')
        return { postal_address: { needs_you: true, why: '没查到，要你填' } }
      }
      const hits = (await kit.search(`${who} contact address`)) ?? []
      if (hits.length === 0) {
        kit.note('联网没搜到地址')
        return { postal_address: { needs_you: true, why: '没查到，要你填' } }
      }
      const got = jsonOf(
        await kit.ask(
          [
            '从下面的网页摘要里找这家公司的实体地址（收得到信的那种）。只摘原文，不要编；找不到就回空串。',
            `公司：${who}`,
            fencedHits(hits),
            '只回 JSON：{"address":""}',
          ].join('\n'),
        ),
      )
      const address = typeof got?.address === 'string' ? got.address.trim() : ''
      const hit = address === '' ? undefined : hitContaining(hits, address)
      if (hit === undefined) {
        kit.note('搜了联系页，没找到写明的地址')
        return { postal_address: { needs_you: true, why: '没查到写明的地址，要你填' } }
      }
      kit.note(`在「${hit.title ?? hit.url}」上找到了地址`, webSource(hit))
      return {
        postal_address: {
          value: address,
          why: '官网上写着的地址',
          sources: [webSource(hit), MODEL_SOURCE],
        },
      }
    },
    async apply(values): Promise<void> {
      const v = values.postal_address?.trim() ?? ''
      if (v.length < 6) throw new SetupCardError('invalid_input', '地址太短了，写全一点。')
      if (!options.setPostalAddress(v))
        throw new SetupCardError('invalid_input', '公司档案还没建好，先走完开工向导。')
    },
  }

  /**
   * WP334（决策 726）：公司档案没填——AI 写文案 / 回客人要用的那几格。设置页「公司档案」仍是总览；
   * 这里只收不是秘密的三格，AI 要卡时可以带建议值（如从官网读到的一句话介绍）。
   */
  const brandFacts = options.brandFacts
  const setBrandFacts = options.setBrandFacts
  const companyProfile: SetupTarget | undefined =
    brandFacts === undefined || setBrandFacts === undefined
      ? undefined
      : {
          id: 'company.profile',
          name: '公司档案',
          why: '写文案、回客人要用到公司的这几样，填好我就接着做。',
          async fields(): Promise<SetupField[]> {
            const now = brandFacts()
            return [
              {
                key: 'one_liner',
                label: '一句话介绍',
                kind: 'text',
                placeholder: '卖什么、给谁用',
                ...(now.one_liner === undefined ? {} : { suggested: now.one_liner }),
                required: true,
              },
              {
                key: 'support_email',
                label: '客服邮箱',
                kind: 'text',
                placeholder: 'support@…',
                ...(now.support_email === undefined ? {} : { suggested: now.support_email }),
                required: false,
              },
              {
                key: 'currency',
                label: '币种',
                kind: 'select',
                options: CURRENCIES.map((c) => ({ value: c, label: c })),
                ...(now.currency === undefined ? {} : { suggested: now.currency }),
                required: false,
              },
            ]
          },
          async satisfied(): Promise<boolean> {
            const v = brandFacts().one_liner?.trim()
            return v !== undefined && v !== ''
          },
          /*
           * WP348：查什么——一句话介绍：档案里的定位（WP346）→ 联网搜官网、问一次模型；
           * 客服邮箱：搜到的网页里原样写着的、官网域名下的邮箱；币种：按目标市场，查不到按 USD 起步。
           */
          async research(kit): Promise<SetupPlan> {
            const facts = await kit.profile()
            const plan: SetupPlan = {}
            const markets = facts.markets ?? []
            const cur = markets.map((m) => CURRENCY_BY_MARKET[m.toUpperCase()]).find((c) => c)
            plan.currency =
              cur === undefined
                ? { value: 'USD', why: '没查到目标市场，先按美元', sources: [DEFAULT_SOURCE] }
                : {
                    value: cur,
                    why: `目标市场是 ${markets.slice(0, 3).join('、')}`,
                    sources: [profileSource('目标市场')],
                  }
            if (facts.positioning !== undefined) {
              const first = facts.positioning.split(/(?<=[。.!！?？])\s*/u)[0] ?? facts.positioning
              plan.one_liner = {
                value: first.slice(0, 120),
                why: '从品牌定位里摘的',
                sources: [profileSource('品牌定位')],
              }
              kit.note('看了品牌档案里的定位', profileSource('品牌定位'))
            }
            const who = facts.domain ?? facts.name
            if (who === undefined) {
              kit.note('档案里没有官网，没法联网查')
              return plan
            }
            const hits = (await kit.search(`${who} about support email`)) ?? []
            const top = hits[0]
            if (top === undefined) {
              kit.note('联网没搜到官网的介绍')
              return plan
            }
            kit.note(`联网搜了官网：${hits.length} 条`, webSource(top))
            const domain = facts.domain?.replace(/^www\./u, '').toLowerCase()
            const email = hits
              .flatMap(
                (h) =>
                  `${h.title ?? ''} ${h.snippet ?? ''}`.match(/[\w.+-]+@[\w-]+\.[\w.-]+/gu) ?? [],
              )
              .find((e) => domain === undefined || e.toLowerCase().endsWith(`@${domain}`))
            if (email !== undefined) {
              const hit = hitContaining(hits, email)
              plan.support_email = {
                value: email,
                why: '官网上写着的邮箱',
                sources: hit === undefined ? [] : [webSource(hit)],
              }
            }
            if (plan.one_liner === undefined) {
              const got = jsonOf(
                await kit.ask(
                  [
                    '下面是一个品牌官网的搜索摘要。用中文写一句话介绍：卖什么、给谁用，30 个字以内，不要夸张。',
                    `品牌：${who}`,
                    fencedHits(hits),
                    '只回 JSON：{"one_liner":""}',
                  ].join('\n'),
                ),
              )
              const one =
                typeof got?.one_liner === 'string' ? got.one_liner.trim().slice(0, 120) : ''
              if (one.length >= 4) {
                plan.one_liner = {
                  value: one,
                  why: '按官网的介绍整理',
                  sources: [webSource(top), MODEL_SOURCE],
                }
                kit.note('问了一次 AI，整理成一句话介绍', MODEL_SOURCE)
              }
            }
            return plan
          },
          async apply(values): Promise<void> {
            const one_liner = values.one_liner?.trim() ?? ''
            if (one_liner.length < 4)
              throw new SetupCardError('invalid_input', '一句话介绍太短了，写全一点。')
            const support_email = values.support_email?.trim()
            if (support_email !== undefined && support_email !== '' && !EMAIL.test(support_email))
              throw new SetupCardError('invalid_input', '客服邮箱看着不对。')
            const ok = setBrandFacts({
              one_liner,
              ...(support_email === undefined || support_email === '' ? {} : { support_email }),
              ...(values.currency === undefined ? {} : { currency: values.currency }),
            })
            if (!ok) throw new SetupCardError('invalid_input', '公司档案还没建好，先走完开工向导。')
          },
        }

  return companyProfile === undefined
    ? [siteStore, companyAddress]
    : [siteStore, companyAddress, companyProfile]
}

/** WP425：「用工坊积分接着做」那张卡的设置目标 id。 */
export const MODEL_FALLBACK_CLOUD_TARGET = 'model.fallback_cloud'

/** WP425：卡上那一格的键。 */
const FALLBACK_KEY = 'fallback_to_cloud'

/**
 * WP425（决策 690）：自己的 AI 用不了（额度用完 / 连不上 / key 失效）、开关「自己的用不了时用工坊积分接着做」
 * 关着时，运行照实停下、在对话里出这张卡——一格开关（建议值「开」），点一下就打开开关、按原话接着做。
 * 没登录工坊账号时不算「缺」（那种情况出的是关联账号的连接卡，不是这一张）。
 */
export function modelFallbackCloudTarget(
  models: () => Promise<{
    fallbackCloud(): { available: boolean; on: boolean }
    setFallbackCloud(on: boolean): void
  }>,
): SetupTarget {
  return {
    id: MODEL_FALLBACK_CLOUD_TARGET,
    name: '用工坊积分接着做',
    why: '你自己的 AI 这一轮用不了，打开下面这个开关就用工坊积分接着做；以后再遇到也自动切，下一轮自动回到你自己的。',
    async fields(): Promise<SetupField[]> {
      return [
        {
          key: FALLBACK_KEY,
          label: '自己的用不了时用工坊积分接着做',
          kind: 'toggle',
          suggested: 'true',
          suggested_why: '只在你自己的 AI 用不了的那一轮用积分，恢复后自动回到你自己的',
          required: true,
        },
      ]
    },
    async satisfied(): Promise<boolean> {
      const now = (await models()).fallbackCloud()
      return !now.available || now.on
    },
    async apply(values): Promise<void> {
      const on = values[FALLBACK_KEY]?.trim() !== 'false'
      const m = await models()
      if (!m.fallbackCloud().available)
        throw new SetupCardError(
          'invalid_input',
          '还没登录工坊账号，先在「设置 → 账号与积分」里登录。',
        )
      m.setFallbackCloud(on)
    },
  }
}
