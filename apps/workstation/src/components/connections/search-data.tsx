/**
 * WP155（docs/81）：连接页的「搜索数据」一行。
 *
 * 给「内容与搜索」职责查搜索结果页（SEO）与问 AI 平台（GEO）用的数据从哪来，三档：
 *
 * - **官方（用积分）**：Agents 工坊官方数据接口，单价常显在按钮旁（从云端状态读，不写死）；
 * - **自带 key**：选服务商 + 填 key，本机直连、不扣积分；
 * - **不接**：SEO / GEO 里要搜索数据的那几步跳过，卡上说一句。
 *
 * 凭据这条线与连接向导、数据后端逐字相同（13 §4.3）：原生 `<form>` + `FormData`，
 * key **不进 React state**、不进 query 缓存、不进 URL；提交完立刻 `form.reset()`；没有 `console.*`。
 *
 * 为什么自带那一档要选服务商（而红人的自带数据接口不给任何预设，docs/75 §4）：
 * 这里接的是服务商**自己的**接口，不是工坊的通用格式——不知道是哪家就拼不出请求。
 * 官方那一档仍然不说用的是哪家。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  clearSearchDataByo,
  getSearchDataSettings,
  type SearchDataProvider,
  type SearchDataRouteChoice,
  setSearchDataByo,
  setSearchDataChoice,
  testSearchDataByo,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'

/** 自带那一档能选的三家（显示名是服务商自己的写法）。 */
const PROVIDERS: readonly { id: SearchDataProvider; label: string }[] = [
  { id: 'dataforseo', label: 'DataForSEO' },
  { id: 'serpapi', label: 'SerpApi' },
  { id: 'serper', label: 'Serper' },
]

const CHOICES: readonly Exclude<SearchDataRouteChoice, 'auto'>[] = ['official', 'byo', 'none']

export function SearchDataSection({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const prefix = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [message, setMessage] = useState<string | undefined>(undefined)

  const settings = useQuery({
    queryKey: ['search-data', assignment],
    queryFn: () => getSearchDataSettings(assignment),
    retry: false,
  })
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['search-data'] })
  }

  const choose = useMutation({
    mutationFn: (choice: SearchDataRouteChoice) => setSearchDataChoice(choice, assignment),
    onSuccess: () => {
      setMessage(undefined)
      refresh()
    },
    onError: (e) => setMessage(apiErrorText(e, t)),
  })
  const save = useMutation({
    mutationFn: (input: { provider: SearchDataProvider; api_key?: string }) =>
      setSearchDataByo(input, assignment),
    onSuccess: () => {
      setMessage(t('search_data.byo.saved'))
      refresh()
    },
    onError: (e) => setMessage(apiErrorText(e, t)),
  })
  const test = useMutation({
    mutationFn: (input: { provider: SearchDataProvider; api_key?: string }) =>
      testSearchDataByo(input, assignment),
    onSuccess: (r) => setMessage(r.message),
    onError: (e) => setMessage(apiErrorText(e, t)),
  })
  const remove = useMutation({
    mutationFn: () => clearSearchDataByo(assignment),
    onSuccess: () => {
      setMessage(undefined)
      refresh()
    },
  })

  const view = settings.data
  const status = view?.status
  // 没选过（auto）时高亮「现在实际走的那一档」；实际哪档都没走就一个都不亮（用户并没有选「不接」）
  const active: Exclude<SearchDataRouteChoice, 'auto'> | undefined =
    view === undefined
      ? undefined
      : view.choice !== 'auto'
        ? view.choice
        : status?.configured === true
          ? status.route
          : undefined
  const busy = choose.isPending || save.isPending || test.isPending || remove.isPending

  /** key 只在这一次调用里存在：从 FormData 取出来直接发，发完 reset。 */
  const readForm = (): { provider: SearchDataProvider; api_key?: string } | undefined => {
    const form = formRef.current
    if (form === null) return undefined
    const data = new FormData(form)
    const provider = String(data.get('provider') ?? '') as SearchDataProvider
    const key = String(data.get('api_key') ?? '').trim()
    return { provider, ...(key === '' ? {} : { api_key: key }) }
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const input = readForm()
    if (input === undefined) return
    save.mutate(input)
    event.currentTarget.reset()
  }
  const runTest = (): void => {
    const input = readForm()
    if (input === undefined) return
    test.mutate(input)
  }

  const priceNote =
    status?.prices === undefined
      ? t('search_data.official.note')
      : t('search_data.official.price', {
          serp: String(status.prices.serp),
          ai: String(status.prices.ai_answer),
        })

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="search-data"
      data-active={active ?? 'none-chosen'}
    >
      <div className="flex items-baseline gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Search className="size-4" aria-hidden />
          {t('search_data.title')}
        </h3>
        <span className="text-xs text-muted-foreground">{t('search_data.subtitle')}</span>
      </div>

      {settings.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : settings.error !== null ? (
        <p role="alert" className="text-xs text-destructive" data-testid="search-data-error">
          {apiErrorText(settings.error, t)}
        </p>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label={t('search_data.title')}
          >
            {CHOICES.map((c) => (
              <Button
                key={c}
                size="sm"
                variant={active === c ? 'default' : 'outline'}
                role="radio"
                aria-checked={active === c}
                data-testid={`search-data-choice-${c}`}
                disabled={busy}
                onClick={() => choose.mutate(c)}
              >
                {t(`search_data.choice.${c}`)}
              </Button>
            ))}
          </div>

          <p className="text-xs text-muted-foreground" data-testid="search-data-status">
            {status?.configured === true
              ? t('search_data.status.ready')
              : (status?.reason ?? t('search_data.status.none'))}
          </p>

          {active === 'official' ? (
            <p className="text-xs text-muted-foreground" data-testid="search-data-price">
              {priceNote}
            </p>
          ) : null}

          {active === 'byo' ? (
            <form
              ref={formRef}
              onSubmit={submit}
              className="flex flex-col gap-2"
              autoComplete="off"
              data-testid="search-data-byo"
            >
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${prefix}-provider`} className="text-xs">
                  {t('search_data.byo.provider')}
                </Label>
                <select
                  id={`${prefix}-provider`}
                  name="provider"
                  defaultValue={view?.byo?.provider ?? 'dataforseo'}
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${prefix}-key`} className="text-xs">
                  {t('search_data.byo.key')}
                </Label>
                <Input
                  id={`${prefix}-key`}
                  name="api_key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  className="h-8 text-xs"
                  placeholder={
                    view?.byo?.has_key === true
                      ? t('search_data.byo.key.set')
                      : t('search_data.byo.key.hint')
                  }
                />
              </div>
              <p className="text-[11px] text-muted-foreground">{t('search_data.byo.note')}</p>
              <div className="flex items-center gap-2">
                <Button type="submit" size="xs" variant="outline" disabled={busy}>
                  {t('search_data.byo.save')}
                </Button>
                <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={runTest}>
                  {t('search_data.byo.test')}
                </Button>
                {view?.byo !== undefined ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => remove.mutate()}
                  >
                    {t('search_data.byo.remove')}
                  </Button>
                ) : null}
              </div>
            </form>
          ) : null}

          {message === undefined ? null : (
            <p className="text-[11px] text-muted-foreground" data-testid="search-data-result">
              {message}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
