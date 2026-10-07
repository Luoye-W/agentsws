/**
 * WP250（决策 103）：Shopify 新店默认首页文字的**哈希**（各语言官方文案，不存原文）。
 * 生成的文件，别手改——改 `scripts/gen-shopify-default-texts.mjs` 再跑一遍。
 *
 * 来源（原文只在生成时临时取，用来认「这家店的首页是不是还没改过」）：
 * - github.com/Shopify/dawn @ 258f00f64365e2018ca4c62778a6bf55a5d3cd18
 * - github.com/Shopify/horizon @ 5acd1b6b66c02f61d3216e3adace5dd9e0404fc9
 * 版权：Copyright (c) 2021-present Shopify Inc.（两个仓库的 LICENSE.md 是带用途限制的 MIT 式许可）。
 *
 * `id` 是「同一处默认文字」：判空店时按 id 计数（同一处的中英两版只算一次）。
 * `sentences` 是这段文案逐句归一后的 SHA-256 前 16 位（规则见 `text-hash.ts`）。
 */
export interface ShopifyDefaultText {
  id: string
  texts: readonly { lang: string; from: string; sentences: readonly string[] }[]
}

export const SHOPIFY_DEFAULT_HOME_TEXTS: readonly ShopifyDefaultText[] = [
  {
    id: 'announcement_welcome',
    texts: [
      {
        lang: 'en',
        from: 'Shopify/dawn@258f00f6:locales/en.default.schema.json#sections.announcement-bar.blocks.announcement.settings.text.default',
        sentences: ['35e72126a410196c'],
      },
      {
        lang: 'zh-CN',
        from: 'Shopify/dawn@258f00f6:locales/zh-CN.schema.json#sections.announcement-bar.blocks.announcement.settings.text.default',
        sentences: ['b09877ec227016fe'],
      },
      {
        lang: 'zh-CN',
        from: 'Shopify/horizon@5acd1b6b:locales/zh-CN.schema.json#text_defaults.welcome_to_our_store',
        sentences: ['37a8c230e9a65643'],
      },
      {
        lang: 'zh-TW',
        from: 'Shopify/dawn@258f00f6:locales/zh-TW.schema.json#sections.announcement-bar.blocks.announcement.settings.text.default',
        sentences: ['8a8b357904bf34ef'],
      },
      {
        lang: 'ja',
        from: 'Shopify/dawn@258f00f6:locales/ja.schema.json#sections.announcement-bar.blocks.announcement.settings.text.default',
        sentences: ['11d5444658e57cd9'],
      },
      {
        lang: 'ja',
        from: 'Shopify/horizon@5acd1b6b:locales/ja.schema.json#text_defaults.welcome_to_our_store',
        sentences: ['b5b17d18550cf4e9'],
      },
      {
        lang: 'ko',
        from: 'Shopify/dawn@258f00f6:locales/ko.schema.json#sections.announcement-bar.blocks.announcement.settings.text.default',
        sentences: ['7b7468c07c5cd50f'],
      },
      {
        lang: 'ko',
        from: 'Shopify/horizon@5acd1b6b:locales/ko.schema.json#text_defaults.welcome_to_our_store',
        sentences: ['6c79b18f90d708c8'],
      },
      {
        lang: 'de',
        from: 'Shopify/dawn@258f00f6:locales/de.schema.json#sections.announcement-bar.blocks.announcement.settings.text.default',
        sentences: ['066cb7f293ce317d'],
      },
      {
        lang: 'fr',
        from: 'Shopify/dawn@258f00f6:locales/fr.schema.json#sections.announcement-bar.blocks.announcement.settings.text.default',
        sentences: ['b43b6f377f386c1b'],
      },
      {
        lang: 'es',
        from: 'Shopify/dawn@258f00f6:locales/es.schema.json#sections.announcement-bar.blocks.announcement.settings.text.default',
        sentences: ['6d49741bc3019695'],
      },
    ],
  },
  {
    id: 'rich_text_heading',
    texts: [
      {
        lang: 'en',
        from: 'Shopify/dawn@258f00f6:locales/en.default.schema.json#sections.rich-text.blocks.heading.settings.heading.default',
        sentences: ['3e23b9865dec01f1'],
      },
      {
        lang: 'zh-CN',
        from: 'Shopify/dawn@258f00f6:locales/zh-CN.schema.json#sections.rich-text.blocks.heading.settings.heading.default',
        sentences: ['2c0014d02c958ed1'],
      },
      {
        lang: 'zh-TW',
        from: 'Shopify/dawn@258f00f6:locales/zh-TW.schema.json#sections.rich-text.blocks.heading.settings.heading.default',
        sentences: ['c087d1d00489784e'],
      },
      {
        lang: 'ja',
        from: 'Shopify/dawn@258f00f6:locales/ja.schema.json#sections.rich-text.blocks.heading.settings.heading.default',
        sentences: ['028535c7f97ffe04'],
      },
      {
        lang: 'ko',
        from: 'Shopify/dawn@258f00f6:locales/ko.schema.json#sections.rich-text.blocks.heading.settings.heading.default',
        sentences: ['78192589cecb242d'],
      },
      {
        lang: 'de',
        from: 'Shopify/dawn@258f00f6:locales/de.schema.json#sections.rich-text.blocks.heading.settings.heading.default',
        sentences: ['da5e69043647f1d7'],
      },
      {
        lang: 'fr',
        from: 'Shopify/dawn@258f00f6:locales/fr.schema.json#sections.rich-text.blocks.heading.settings.heading.default',
        sentences: ['e2fdfd278410b518'],
      },
      {
        lang: 'es',
        from: 'Shopify/dawn@258f00f6:locales/es.schema.json#sections.rich-text.blocks.heading.settings.heading.default',
        sentences: ['5d0031410c27650a'],
      },
    ],
  },
  {
    id: 'rich_text_body',
    texts: [
      {
        lang: 'en',
        from: 'Shopify/dawn@258f00f6:locales/en.default.schema.json#sections.rich-text.blocks.text.settings.text.default',
        sentences: ['54e27439512f6692', '395d3f1c7cc9604e'],
      },
      {
        lang: 'zh-CN',
        from: 'Shopify/dawn@258f00f6:locales/zh-CN.schema.json#sections.rich-text.blocks.text.settings.text.default',
        sentences: ['a24eb266e7dfab3f', '1c24c2efd00aaf42'],
      },
      {
        lang: 'zh-CN',
        from: 'Shopify/horizon@5acd1b6b:locales/zh-CN.schema.json#html_defaults.share_information_about_your',
        sentences: ['4f6e88c41de60807', '24946c4609b4e2ab'],
      },
      {
        lang: 'zh-TW',
        from: 'Shopify/dawn@258f00f6:locales/zh-TW.schema.json#sections.rich-text.blocks.text.settings.text.default',
        sentences: ['01aabf9795d11491'],
      },
      {
        lang: 'zh-TW',
        from: 'Shopify/horizon@5acd1b6b:locales/zh-TW.schema.json#html_defaults.share_information_about_your',
        sentences: ['d1198bedc52bcbdf', '8beed9615c7df3ed'],
      },
      {
        lang: 'ja',
        from: 'Shopify/dawn@258f00f6:locales/ja.schema.json#sections.rich-text.blocks.text.settings.text.default',
        sentences: ['1539bd2c16fa1463', '1639578d61055e86'],
      },
      {
        lang: 'ja',
        from: 'Shopify/horizon@5acd1b6b:locales/ja.schema.json#html_defaults.share_information_about_your',
        sentences: ['99de33a8bd09b7a8', '39fa6aa6ff48b430'],
      },
      {
        lang: 'ko',
        from: 'Shopify/dawn@258f00f6:locales/ko.schema.json#sections.rich-text.blocks.text.settings.text.default',
        sentences: ['b91a8a4e6b0a138d', '773206990fa086f6'],
      },
      {
        lang: 'ko',
        from: 'Shopify/horizon@5acd1b6b:locales/ko.schema.json#html_defaults.share_information_about_your',
        sentences: ['fdc6aab760579d93', 'd5b1b702e37f4fde'],
      },
      {
        lang: 'de',
        from: 'Shopify/dawn@258f00f6:locales/de.schema.json#sections.rich-text.blocks.text.settings.text.default',
        sentences: ['9bc94d1dd2341ba4', '2a6f46ba7a93cafd'],
      },
      {
        lang: 'de',
        from: 'Shopify/horizon@5acd1b6b:locales/de.schema.json#html_defaults.share_information_about_your',
        sentences: ['a596a5439e1a2e46', '93281f27432c0e75'],
      },
      {
        lang: 'fr',
        from: 'Shopify/dawn@258f00f6:locales/fr.schema.json#sections.rich-text.blocks.text.settings.text.default',
        sentences: ['4af202b81b030e68', 'd7a442a3e0875e56'],
      },
      {
        lang: 'fr',
        from: 'Shopify/horizon@5acd1b6b:locales/fr.schema.json#html_defaults.share_information_about_your',
        sentences: ['be2e30709bd1d6d5', '5e3ce6d097618a3a'],
      },
      {
        lang: 'es',
        from: 'Shopify/dawn@258f00f6:locales/es.schema.json#sections.rich-text.blocks.text.settings.text.default',
        sentences: ['ef501721980dc853', '9b8b8ed47266fdcf'],
      },
      {
        lang: 'es',
        from: 'Shopify/horizon@5acd1b6b:locales/es.schema.json#html_defaults.share_information_about_your',
        sentences: ['320e78c016a763c4', 'a5770801bffd5021'],
      },
    ],
  },
  {
    id: 'image_banner_heading',
    texts: [
      {
        lang: 'en',
        from: 'Shopify/dawn@258f00f6:locales/en.default.schema.json#sections.image-banner.blocks.heading.settings.heading.default',
        sentences: ['ccab913fd5136452'],
      },
      {
        lang: 'zh-CN',
        from: 'Shopify/dawn@258f00f6:locales/zh-CN.schema.json#sections.image-banner.blocks.heading.settings.heading.default',
        sentences: ['b31d71b7df55e392'],
      },
      {
        lang: 'zh-TW',
        from: 'Shopify/dawn@258f00f6:locales/zh-TW.schema.json#sections.image-banner.blocks.heading.settings.heading.default',
        sentences: ['c143f0787b94189f'],
      },
      {
        lang: 'ja',
        from: 'Shopify/dawn@258f00f6:locales/ja.schema.json#sections.image-banner.blocks.heading.settings.heading.default',
        sentences: ['a3facf917bb67272'],
      },
      {
        lang: 'ko',
        from: 'Shopify/dawn@258f00f6:locales/ko.schema.json#sections.image-banner.blocks.heading.settings.heading.default',
        sentences: ['2bd916f61872af4a'],
      },
      {
        lang: 'de',
        from: 'Shopify/dawn@258f00f6:locales/de.schema.json#sections.image-banner.blocks.heading.settings.heading.default',
        sentences: ['da3a087ac09b7989'],
      },
      {
        lang: 'fr',
        from: 'Shopify/dawn@258f00f6:locales/fr.schema.json#sections.image-banner.blocks.heading.settings.heading.default',
        sentences: ['04332a538b430c08'],
      },
      {
        lang: 'es',
        from: 'Shopify/dawn@258f00f6:locales/es.schema.json#sections.image-banner.blocks.heading.settings.heading.default',
        sentences: ['e7558485d2b09d41'],
      },
    ],
  },
  {
    id: 'image_banner_text',
    texts: [
      {
        lang: 'en',
        from: 'Shopify/dawn@258f00f6:locales/en.default.schema.json#sections.image-banner.blocks.text.settings.text.default',
        sentences: ['23bc9065b00b45d4'],
      },
      {
        lang: 'zh-CN',
        from: 'Shopify/dawn@258f00f6:locales/zh-CN.schema.json#sections.image-banner.blocks.text.settings.text.default',
        sentences: ['d2fffe3ac46f872f'],
      },
      {
        lang: 'zh-TW',
        from: 'Shopify/dawn@258f00f6:locales/zh-TW.schema.json#sections.image-banner.blocks.text.settings.text.default',
        sentences: ['b2f5e11dc69c25b6'],
      },
      {
        lang: 'ja',
        from: 'Shopify/dawn@258f00f6:locales/ja.schema.json#sections.image-banner.blocks.text.settings.text.default',
        sentences: ['87365a6d7f4213c4'],
      },
      {
        lang: 'ko',
        from: 'Shopify/dawn@258f00f6:locales/ko.schema.json#sections.image-banner.blocks.text.settings.text.default',
        sentences: ['da663e10f08d9403'],
      },
      {
        lang: 'de',
        from: 'Shopify/dawn@258f00f6:locales/de.schema.json#sections.image-banner.blocks.text.settings.text.default',
        sentences: ['bacf3c57a1742cc5'],
      },
      {
        lang: 'fr',
        from: 'Shopify/dawn@258f00f6:locales/fr.schema.json#sections.image-banner.blocks.text.settings.text.default',
        sentences: ['39978f1595f0bcfe'],
      },
      {
        lang: 'es',
        from: 'Shopify/dawn@258f00f6:locales/es.schema.json#sections.image-banner.blocks.text.settings.text.default',
        sentences: ['72b1485a5b8a8845'],
      },
    ],
  },
  {
    id: 'image_with_text_body',
    texts: [
      {
        lang: 'en',
        from: 'Shopify/dawn@258f00f6:locales/en.default.schema.json#sections.image-with-text.blocks.text.settings.text.default',
        sentences: ['f21b68c9751475b8', '25a453cc71bca3ce'],
      },
      {
        lang: 'zh-CN',
        from: 'Shopify/dawn@258f00f6:locales/zh-CN.schema.json#sections.image-with-text.blocks.text.settings.text.default',
        sentences: ['ba07ac087521fa7f', '042dc88030d2e163'],
      },
      {
        lang: 'zh-TW',
        from: 'Shopify/dawn@258f00f6:locales/zh-TW.schema.json#sections.image-with-text.blocks.text.settings.text.default',
        sentences: ['26f47c6b456e60ab', '7ab2b4699df01216'],
      },
      {
        lang: 'ja',
        from: 'Shopify/dawn@258f00f6:locales/ja.schema.json#sections.image-with-text.blocks.text.settings.text.default',
        sentences: ['c41eb4e5c5db0297', '81c489cf140e89c7'],
      },
      {
        lang: 'ko',
        from: 'Shopify/dawn@258f00f6:locales/ko.schema.json#sections.image-with-text.blocks.text.settings.text.default',
        sentences: ['4f3a0e2674b27732', '586670852e74d477'],
      },
      {
        lang: 'de',
        from: 'Shopify/dawn@258f00f6:locales/de.schema.json#sections.image-with-text.blocks.text.settings.text.default',
        sentences: ['c7f19e4e4ded1f82', 'b4d416ebb4c7b011'],
      },
      {
        lang: 'fr',
        from: 'Shopify/dawn@258f00f6:locales/fr.schema.json#sections.image-with-text.blocks.text.settings.text.default',
        sentences: ['a0a34e71c36bd10c', '744c81575a133fb9', '7f39552ba6e848c7'],
      },
      {
        lang: 'es',
        from: 'Shopify/dawn@258f00f6:locales/es.schema.json#sections.image-with-text.blocks.text.settings.text.default',
        sentences: ['7afb4beddaced598', 'd370b8395d181c12'],
      },
    ],
  },
  {
    id: 'example_product_title',
    texts: [
      {
        lang: 'en',
        from: 'Shopify/dawn@258f00f6:locales/en.default.json#onboarding.product_title',
        sentences: ['791c13bced08ffd9'],
      },
      {
        lang: 'zh-CN',
        from: 'Shopify/dawn@258f00f6:locales/zh-CN.json#onboarding.product_title',
        sentences: ['62f65745a3664925'],
      },
      {
        lang: 'zh-TW',
        from: 'Shopify/dawn@258f00f6:locales/zh-TW.json#onboarding.product_title',
        sentences: ['d284b8fb440ed44d'],
      },
      {
        lang: 'ja',
        from: 'Shopify/dawn@258f00f6:locales/ja.json#onboarding.product_title',
        sentences: ['d5226e06c48482e2'],
      },
      {
        lang: 'ko',
        from: 'Shopify/dawn@258f00f6:locales/ko.json#onboarding.product_title',
        sentences: ['ab9d4d1ba5f78253'],
      },
      {
        lang: 'de',
        from: 'Shopify/dawn@258f00f6:locales/de.json#onboarding.product_title',
        sentences: ['61acf8b723fa5935'],
      },
      {
        lang: 'fr',
        from: 'Shopify/dawn@258f00f6:locales/fr.json#onboarding.product_title',
        sentences: ['39c2ba65e0fa721b'],
      },
      {
        lang: 'es',
        from: 'Shopify/dawn@258f00f6:locales/es.json#onboarding.product_title',
        sentences: ['76ad21cfc3d1bc12'],
      },
    ],
  },
  {
    id: 'home_banner_browse',
    texts: [
      {
        lang: 'en',
        from: 'Shopify/dawn@258f00f6:templates/index.json#sections.image_banner.blocks.heading.settings.heading',
        sentences: ['2f8ad1113a37a409'],
      },
    ],
  },
  {
    id: 'legacy_content_goes_here',
    texts: [
      { lang: 'en', from: 'WP244（老主题英文，出处未核实）', sentences: ['6fe4c52e1351d423'] },
    ],
  },
  {
    id: 'legacy_use_this_text',
    texts: [
      { lang: 'en', from: 'WP244（老主题英文，出处未核实）', sentences: ['e15e85a5cd3da550'] },
    ],
  },
]
