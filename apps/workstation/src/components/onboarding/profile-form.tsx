/**
 * 第 ① 步（46 §1 ①，WP65 按 52 O4 拆成两块）。
 *
 * **上半块「公司」**：全称、邮箱域名、"让同事找到我"开关 —— 它们进的是**组织**
 * （52 O1：公司 = 组织；46 §2 的同事发现钥匙从这三样算）。
 * **下半块「品牌」**：品牌名、你卖的是、网站是用什么搭的 —— 它们进的是**这个品牌
 * 工作区**（52 O1：品牌 = 工作区）。
 *
 * 为什么非拆不可：一个人可以有两个品牌，一个卖实物一个卖课，网站一个 Shopify
 * 一个自己搭的——把这五样堆在"公司"一栏里，第二个品牌就没地方放了。
 *
 * 向导第 ① 步与设置页用的是同一个件——46 §1 末段说的"后续从公司页和设置页都能改"，
 * 靠的就是它只有一份。
 *
 * 那句"只交换一串哈希"是 36 §7 的**可见**档（安全承诺不许藏进 tooltip）：
 * 用户凭它决定要不要把开关打开。
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint, SafetyNote } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type {
  StorefrontPlatform,
  StorefrontPlatformChoiceView,
  VerticalChoiceView,
  WorkspaceProfileView,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface ProfileDraft {
  legal_name: string
  domain: string
  discoverable: boolean
  /** WP65（52 O4）：这个品牌叫什么。空着 = 不改（默认等于工作区名）。 */
  brand_name: string
  /** 48 v2 L2：你卖的是实物商品 / 虚拟产品与服务。默认实物。 */
  vertical: 'goods' | 'digital'
  /** WP62（51 §1 N0）：网站是用什么搭的。默认 Shopify。 */
  storefront_platform: StorefrontPlatform
}

export function ProfileForm({
  profile,
  emailHint,
  verticals,
  storefrontPlatforms,
  allowUnsupported = false,
  firstBrand = false,
  busy,
  saved,
  error,
  onSave,
}: {
  profile?: WorkspaceProfileView
  /** 登录邮箱——域名那一格从它带出来（46 §1 表 ①）。 */
  emailHint?: string
  /**
   * 48 v2 L2「你卖的是」的两个选项与各自一句人话。
   * **从服务端来**（真源是客服共享包的垂直包），界面不自己写一份文案——
   * 那两句话要跟 AI 实际被告知的口径是同一份。
   */
  verticals?: VerticalChoiceView[]
  /**
   * WP62（51 §1 N0）「网站是用什么搭的」四个选项。**从服务端来**（真源是契约里的
   * `STOREFRONT_PLATFORMS`），界面不自己写一份清单——支持哪几个是一件会变的事，
   * 变的时候只该改契约那一张表。
   */
  storefrontPlatforms?: StorefrontPlatformChoiceView[]
  /**
   * 能不能选"还接不上"的平台。首次设置里**不能**（51 §1：现在只开 Shopify）；
   * 设置页里能，但要先过一次二次确认——已经连上的店铺后台会因此失效。
   */
  allowUnsupported?: boolean
  /**
   * WP65（52 O4）：下半块的标题说的是"**第一个**品牌"还是"这个品牌"。
   * 向导里是前者（后面还可以在公司页加第二个），设置页里是后者。
   */
  firstBrand?: boolean
  busy: boolean
  saved: boolean
  error?: string
  onSave(draft: ProfileDraft): void
}): React.ReactNode {
  const { t } = useApp()
  const suggested = emailHint?.split('@')[1] ?? ''
  const [draft, setDraft] = useState<ProfileDraft>({
    legal_name: profile?.legal_name ?? '',
    domain: profile?.domain ?? suggested,
    discoverable: profile?.discoverable ?? true,
    brand_name: profile?.brand_name ?? '',
    vertical: profile?.vertical ?? 'goods',
    storefront_platform: profile?.storefront_platform ?? 'shopify',
  })
  /** 选中的那一条「你卖的是」——它那一句人话是这一栏**唯一**出的解释（WP79 ⑤）。 */
  const pickedVertical = verticals?.find((v) => v.key === draft.vertical)

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="onboarding-profile">
      {/* ── 上半块：公司（→ 组织；52 O1 / O3「人、钱、发现」都挂在它上面）── */}
      <section className="flex flex-col gap-3" data-testid="profile-company-block">
        {/*
          WP79 ② / ③：**向导里这两个灰色小标题都不出**。
          第 ① 步的标题已经是「公司设置」了，下面再写一遍"公司"是同一句话说两次；
          品牌那三样直接接在公司字段下面，一步一张表比两个分组更省事。
          设置页里它们还在——那一页上下文多，分组是有用的。
        */}
        {firstBrand ? null : (
          <p className="text-xs font-medium text-muted-foreground">
            {t('onboarding.block.company')}
          </p>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="company-legal-name" className="flex items-center gap-1">
            {t('onboarding.company.legal_name')}
            <Hint text={t('onboarding.company.legal_name.hint')} testId="company-name-hint" />
          </Label>
          <Input
            id="company-legal-name"
            data-testid="company-legal-name"
            value={draft.legal_name}
            placeholder={t('onboarding.company.legal_name.placeholder')}
            onChange={(e) => {
              setDraft({ ...draft, legal_name: e.target.value })
            }}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="company-domain" className="flex items-center gap-1">
            {t('onboarding.company.domain')}
            <Hint text={t('onboarding.company.domain.hint')} />
          </Label>
          <Input
            id="company-domain"
            data-testid="company-domain"
            value={draft.domain}
            placeholder="nordvolt.cn"
            onChange={(e) => {
              setDraft({ ...draft, domain: e.target.value })
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="company-discoverable" className="flex items-center gap-1">
            {t('onboarding.company.discoverable')}
            <Hint text={t('onboarding.company.discoverable.hint')} />
          </Label>
          <Switch
            id="company-discoverable"
            data-testid="company-discoverable"
            checked={draft.discoverable}
            onCheckedChange={(next) => {
              setDraft({ ...draft, discoverable: next })
            }}
          />
        </div>
        <SafetyNote text={t('onboarding.company.promise')} />
      </section>

      {/* ── 下半块：品牌（→ 这个工作区；52 O1「品牌 = 工作区」）── */}
      <section className="flex flex-col gap-3" data-testid="profile-brand-block">
        {firstBrand ? null : (
          <p className="text-xs font-medium text-muted-foreground">{t('onboarding.block.brand')}</p>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="brand-name" className="flex items-center gap-1">
            {t('onboarding.brand.name')}
            <Hint text={t('onboarding.brand.name.hint')} testId="brand-name-hint" />
          </Label>
          <Input
            id="brand-name"
            data-testid="brand-name"
            value={draft.brand_name}
            placeholder={t('onboarding.brand.name.placeholder')}
            onChange={(e) => {
              setDraft({ ...draft, brand_name: e.target.value })
            }}
          />
        </div>

        {/*
        两个"这个**品牌**是什么样"的问题**并排**（46 §1 ①、51 §1 N0、52 O1）：
        左边「你卖的是」决定客服 AI 用哪一套人设、词表与业务边界；
        右边「网站是用什么搭的」决定店铺连接、面板取数与职责连接器解析到哪个平台。
        两样都是**品牌级**的——同一家公司的两个品牌可以一个卖实物一个卖课。
        窄屏一列，宽屏两列——它们是同一层的两个选择，不该一个在上一个在下。
      */}
        {(verticals === undefined || verticals.length === 0) &&
        (storefrontPlatforms === undefined || storefrontPlatforms.length === 0) ? null : (
          <div className="grid gap-3 sm:grid-cols-2">
            {verticals === undefined || verticals.length === 0 ? null : (
              <div className="flex flex-col gap-1">
                <Label className="flex items-center gap-1">
                  {t('onboarding.company.vertical')}
                  <Hint
                    text={t('onboarding.company.vertical.hint')}
                    testId="company-vertical-hint"
                  />
                </Label>
                <div
                  className="flex flex-wrap gap-x-4 gap-y-1"
                  role="radiogroup"
                  data-testid="company-vertical"
                >
                  {verticals.map((v) => (
                    <label
                      key={v.key}
                      htmlFor={`company-vertical-${v.key}`}
                      className="flex items-center gap-2"
                    >
                      <input
                        id={`company-vertical-${v.key}`}
                        data-testid={`company-vertical-${v.key}`}
                        type="radio"
                        name="company-vertical"
                        checked={draft.vertical === v.key}
                        onChange={() => {
                          setDraft({ ...draft, vertical: v.key })
                        }}
                      />
                      <span className="font-medium">{v.label}</span>
                    </label>
                  ))}
                </div>
                {/*
                  WP79 ⑤：两个选项各一行解释 → **只出选中那一条的**。
                  那句话仍然从服务端来（真源是客服共享包的垂直包，界面不自己写一份），
                  只是同一时刻最多占一行：没选中的那条解释，看的人这会儿并不需要。
                */}
                {pickedVertical?.hint === undefined ? null : (
                  <p className="text-xs text-muted-foreground" data-testid="company-vertical-note">
                    {pickedVertical.hint}
                  </p>
                )}
              </div>
            )}

            {storefrontPlatforms === undefined || storefrontPlatforms.length === 0 ? null : (
              <div className="flex flex-col gap-1">
                <Label className="flex items-center gap-1">
                  {t('onboarding.company.platform')}
                  <Hint
                    text={t('onboarding.company.platform.hint')}
                    testId="company-platform-hint"
                  />
                </Label>
                <div
                  className="flex flex-col gap-1"
                  role="radiogroup"
                  data-testid="company-platform"
                >
                  {storefrontPlatforms.map((p) => {
                    // 接不上的那几个**照样画出来**，只是点不动并把"为什么"说在一句 tooltip 里：
                    // 藏起来的话用户只会以为我们不知道有这个平台（51 §1 N0）。
                    // 设置页（`allowUnsupported`）例外：已经在用别的平台的人要改得动，
                    // 但改之前先说清代价——店铺连接会失效。
                    const locked = !p.supported && !allowUnsupported
                    return (
                      <label
                        key={p.key}
                        htmlFor={`company-platform-${p.key}`}
                        className={
                          p.supported
                            ? 'flex items-center gap-2'
                            : 'flex items-center gap-2 text-muted-foreground'
                        }
                        title={
                          p.supported
                            ? undefined
                            : (p.hint ?? t('onboarding.company.platform.unsupported'))
                        }
                      >
                        <input
                          id={`company-platform-${p.key}`}
                          data-testid={`company-platform-${p.key}`}
                          type="radio"
                          name="company-platform"
                          disabled={locked}
                          checked={draft.storefront_platform === p.key}
                          onChange={() => {
                            if (
                              !p.supported &&
                              !globalThis.confirm(
                                t('settings.company.platform_change', { label: p.label }),
                              )
                            ) {
                              return
                            }
                            setDraft({ ...draft, storefront_platform: p.key })
                          }}
                        />
                        <span className="font-medium">{p.label}</span>
                        {/*
                          WP79 ④：`none`（还没开始搭建）是**选得动**的，但它也有一句
                          "选了会怎样"——所以这里的判据从"支不支持"改成"服务端给没给这一句"。
                        */}
                        {p.supported && p.hint === undefined ? null : (
                          <Hint
                            text={p.hint ?? t('onboarding.company.platform.unsupported')}
                            testId={`company-platform-${p.key}-hint`}
                          />
                        )}
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {error === undefined ? null : (
        <p role="alert" className="text-destructive" data-testid="company-error">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        {saved ? (
          <span className="text-xs text-muted-foreground" data-testid="company-saved">
            {t('onboarding.company.saved')}
          </span>
        ) : null}
        <Button
          size="sm"
          data-testid="company-save"
          disabled={busy || draft.legal_name.trim() === ''}
          onClick={() => {
            onSave(draft)
          }}
        >
          {/* WP79 ⑥：向导里保存完就进下一步，所以按钮说的是「保存并继续」 */}
          {t(firstBrand ? 'onboarding.company.save_next' : 'onboarding.company.save')}
        </Button>
      </div>
    </div>
  )
}
