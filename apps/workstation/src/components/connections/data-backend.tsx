/**
 * 连接页的「数据后端」一节（41 §2.4）。
 *
 * 三个按钮，一句话说清各自是什么：
 * **本地（默认）/ 接我的云 / 用 agentsws 托管**。
 *
 * 凭据这条线与连接向导逐字相同（13 §4.3）：
 * 1. 原生 `<form>` + `FormData` 收集，值**不进 React state**、不进 query 缓存、不进 URL；
 * 2. 秘密字段一律 `type="password"` + `autoComplete="off"` + `data-1p-ignore`；
 * 3. 只打 `/v1/storage/test` 与 `/v1/storage/backend` 两条路，提交完立刻 `form.reset()`；
 * 4. 全程没有一次 `console.*`。
 *
 * 「用 agentsws 托管」这一档在 WP40 里**只有说明**，没有集群（41 §2.3）——
 * 按钮点开是一段实话，不是一个假的开通流程。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cloud, Database, ExternalLink, HardDrive, Server, ShieldCheck } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { openExternal } from '@/components/connections/bridge'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getStorage,
  getStorageMigration,
  migrateStorage,
  type StorageBackendInput,
  type StorageMigrationView,
  type StorageTestResult,
  saveStorageBackend,
  testStorageBackend,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

type Choice = 'local' | 'byo_cloud' | 'managed'

/** 迁移轮询：1 秒一次，最多 10 分钟。 */
const POLL_MS = 1000
const POLL_LIMIT = 600

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export function DataBackend({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const prefix = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [choice, setChoice] = useState<Choice | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [testResult, setTestResult] = useState<{
    database?: StorageTestResult
    blobs?: StorageTestResult
  } | null>(null)
  const [saved, setSaved] = useState<string[] | null>(null)
  const [migration, setMigration] = useState<StorageMigrationView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const storage = useQuery({
    queryKey: ['storage', assignment],
    enabled: assignment !== undefined,
    queryFn: () => getStorage(assignment),
  })

  const stopPolling = useCallback((): void => {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  /** 表单 → 一份只在这次调用里存在的值。空字段直接不出现（后端会沿用旧的）。 */
  const collect = (form: HTMLFormElement): StorageBackendInput => {
    const data = new FormData(form)
    const out: Record<string, string> = {}
    for (const name of [
      'database_url',
      'blob_endpoint',
      'blob_bucket',
      'blob_region',
      'blob_prefix',
      'blob_access_key_id',
      'blob_secret_access_key',
    ] as const) {
      const raw = data.get(name)
      const value = typeof raw === 'string' ? raw.trim() : ''
      if (value !== '') out[name] = value
    }
    return out as StorageBackendInput
  }

  const test = useMutation({
    mutationFn: (input: StorageBackendInput) => testStorageBackend(input, assignment),
    onSuccess: (out) => {
      setTestResult(out)
      setError(null)
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  const save = useMutation({
    mutationFn: (input: StorageBackendInput) => saveStorageBackend(input, assignment),
    onSuccess: (out) => {
      setSaved(out.saved_fields)
      setError(null)
      // 值发出去之后连 DOM 里也不留
      formRef.current?.reset()
      void client.invalidateQueries({ queryKey: ['storage'] })
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  const startPolling = useCallback(
    (id: string): void => {
      let tries = 0
      const tick = async (): Promise<void> => {
        tries += 1
        try {
          const next = await getStorageMigration(id, assignment)
          setMigration(next)
          if (next.state !== 'running') {
            void client.invalidateQueries({ queryKey: ['storage'] })
            return
          }
        } catch {
          // 网络抖一下不该把进度页打死；下一轮接着问
        }
        if (tries < POLL_LIMIT) pollTimer.current = setTimeout(() => void tick(), POLL_MS)
      }
      pollTimer.current = setTimeout(() => void tick(), POLL_MS)
    },
    [assignment, client],
  )

  const migrate = useMutation({
    mutationFn: () => migrateStorage(assignment),
    onSuccess: (out) => {
      setMigration(out)
      setError(null)
      startPolling(out.id)
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate(collect(event.currentTarget))
  }

  const view = storage.data
  const active: Choice = view?.tier ?? 'local'
  const selected = choice ?? active

  return (
    <section className="mt-8" data-testid="data-backend">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium">{t('storage.title')}</h2>
        <span className="text-xs text-muted-foreground">{t('storage.subtitle')}</span>
      </div>

      {/* 现在用的是哪一档 */}
      {storage.isLoading ? (
        <Skeleton className="mt-3 h-20 w-full" />
      ) : view === undefined ? null : (
        <dl
          className="mt-3 grid gap-3 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-3"
          data-testid="storage-current"
          data-tier={view.tier}
        >
          <div>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <Database className="size-3.5" aria-hidden />
              {t('storage.database')}
            </dt>
            <dd className="mt-1 font-medium break-all" data-testid="storage-database">
              {view.database.kind} · {view.database.display}
            </dd>
            <dd className="text-muted-foreground">{formatBytes(view.database.bytes)}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-muted-foreground">
              <HardDrive className="size-3.5" aria-hidden />
              {t('storage.blobs')}
            </dt>
            <dd className="mt-1 font-medium break-all" data-testid="storage-blobs">
              {view.blobs.kind} · {view.blobs.display}
            </dd>
            <dd className="text-muted-foreground">
              {formatBytes(view.blobs.bytes)}
              {view.blobs.objects === undefined
                ? null
                : ` · ${t('storage.objects', { n: view.blobs.objects })}`}
              {view.blobs.encrypted === true ? ` · ${t('storage.encrypted')}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('storage.last_backup')}</dt>
            <dd className="mt-1 font-medium" data-testid="storage-last-backup">
              {view.last_backup_at ?? t('storage.never_backed_up')}
            </dd>
            {view.previous_backend_readonly_until === undefined ? null : (
              <dd className="text-muted-foreground">
                {t('storage.retire_until', { at: view.previous_backend_readonly_until })}
              </dd>
            )}
          </div>
        </dl>
      )}

      {/* 三个按钮 */}
      <fieldset className="mt-3 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">{t('storage.title')}</legend>
        {(
          [
            { id: 'local', icon: HardDrive, label: t('storage.tier.local') },
            { id: 'byo_cloud', icon: Cloud, label: t('storage.tier.byo') },
            { id: 'managed', icon: Server, label: t('storage.tier.managed') },
          ] as const
        ).map(({ id, icon: Icon, label }) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={selected === id ? 'default' : 'outline'}
            data-testid={`storage-tier-${id}`}
            aria-pressed={selected === id}
            onClick={() => {
              setChoice(id)
              setTestResult(null)
              setSaved(null)
              setError(null)
            }}
          >
            <Icon className="mr-1.5 size-3.5" aria-hidden />
            {label}
            {active === id ? (
              <span className="ml-1.5 text-[10px] opacity-80">{t('storage.in_use')}</span>
            ) : null}
          </Button>
        ))}
      </fieldset>

      {selected === 'local' ? (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="storage-local-note">
          {t('storage.local.note')}
        </p>
      ) : null}

      {selected === 'managed' ? (
        <div
          className="mt-3 rounded-lg border bg-muted/20 p-3 text-xs"
          data-testid="storage-managed"
        >
          <p>{t('storage.managed.note')}</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mt-2 px-0"
            onClick={() => openExternal('https://agentsws.com/hosting')}
          >
            {t('storage.managed.learn')}
            <ExternalLink className="ml-1 size-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}

      {/* 接我的云：原生表单 */}
      {selected === 'byo_cloud' ? (
        <form
          ref={formRef}
          data-testid="storage-form"
          className="mt-3 flex flex-col gap-3 rounded-lg border bg-muted/30 p-3"
          onSubmit={submit}
          autoComplete="off"
        >
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{t('storage.never_ai')}</span>
          </p>

          <Field
            id={`${prefix}-database_url`}
            name="database_url"
            label={t('storage.field.database_url')}
            hint={t('storage.field.database_url.hint')}
            placeholder="postgres://用户:密码@主机:5432/库名"
            secret
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id={`${prefix}-blob_endpoint`}
              name="blob_endpoint"
              label={t('storage.field.endpoint')}
              hint={t('storage.field.endpoint.hint')}
              placeholder="https://oss-cn-shenzhen.aliyuncs.com"
            />
            <Field
              id={`${prefix}-blob_bucket`}
              name="blob_bucket"
              label={t('storage.field.bucket')}
              placeholder="my-company"
            />
            <Field
              id={`${prefix}-blob_region`}
              name="blob_region"
              label={t('storage.field.region')}
              placeholder="cn-shenzhen"
            />
            <Field
              id={`${prefix}-blob_prefix`}
              name="blob_prefix"
              label={t('storage.field.prefix')}
              hint={t('storage.field.prefix.hint')}
              placeholder="agentsws"
            />
            <Field
              id={`${prefix}-blob_access_key_id`}
              name="blob_access_key_id"
              label={t('storage.field.access_key')}
            />
            <Field
              id={`${prefix}-blob_secret_access_key`}
              name="blob_secret_access_key"
              label={t('storage.field.secret_key')}
              secret
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="storage-test"
              disabled={test.isPending}
              onClick={() => {
                const form = formRef.current
                if (form !== null) test.mutate(collect(form))
              }}
            >
              {test.isPending ? t('storage.testing') : t('storage.test')}
            </Button>
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? t('storage.saving') : t('storage.save')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="storage-migrate"
              disabled={migrate.isPending || saved === null}
              title={saved === null ? t('storage.migrate.needs_save') : undefined}
              onClick={() => migrate.mutate()}
            >
              {migrate.isPending ? t('storage.migrating') : t('storage.migrate')}
            </Button>
          </div>

          {testResult === null ? null : (
            <ul className="flex flex-col gap-1 text-xs" data-testid="storage-test-result">
              {(['database', 'blobs'] as const).map((key) => {
                const r = testResult[key]
                if (r === undefined) return null
                return (
                  <li key={key} data-ok={r.ok ? 'true' : 'false'}>
                    <span className={r.ok ? 'text-emerald-600' : 'text-destructive'}>
                      {r.ok ? '✓' : '✗'} {t(`storage.${key}`)}
                    </span>
                    <span className="ml-1 text-muted-foreground">{r.detail ?? r.reason}</span>
                  </li>
                )
              })}
            </ul>
          )}

          {saved === null ? null : (
            <p className="text-xs text-muted-foreground" data-testid="storage-saved">
              {t('storage.saved', { fields: saved.join('、') })}
            </p>
          )}

          {migration === null ? null : (
            <div
              className="rounded-md bg-muted/60 px-2 py-1.5 text-xs"
              data-testid="storage-migration"
              data-state={migration.state}
              data-step={migration.step}
            >
              <p>
                {t(`storage.step.${migration.step}`)}
                {migration.state === 'failed' ? ` — ${migration.reason ?? ''}` : ''}
              </p>
              {migration.state === 'done' ? (
                <p className="mt-1 text-muted-foreground">
                  {t('storage.migrate.done', {
                    n: migration.exported_records ?? 0,
                    at: migration.previous_readonly_until ?? '',
                  })}
                </p>
              ) : null}
            </div>
          )}

          {error === null ? null : (
            <p className="text-xs text-destructive" data-testid="storage-error">
              {error}
            </p>
          )}
        </form>
      ) : null}

      {/* 高级：环境变量与 compose */}
      <div className="mt-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="px-0 text-xs"
          data-testid="storage-advanced-toggle"
          onClick={() => setAdvanced((on) => !on)}
        >
          {advanced ? t('storage.advanced.close') : t('storage.advanced.open')}
        </Button>
        {advanced && view !== undefined ? (
          <div
            className="mt-2 rounded-lg border bg-muted/20 p-3 text-xs"
            data-testid="storage-advanced"
          >
            <p className="text-muted-foreground">{t('storage.advanced.note')}</p>
            <dl className="mt-2 grid gap-1">
              {view.env.map((row) => (
                <div key={row.name} className="flex flex-wrap gap-2">
                  <dt className="font-mono text-[11px]">{row.name}</dt>
                  <dd className="font-mono text-[11px] text-muted-foreground break-all">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mt-2 px-0"
              onClick={() => openExternal(view.compose_url)}
            >
              {t('storage.advanced.compose')}
              <ExternalLink className="ml-1 size-3.5" aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** 一个原生输入框。秘密字段永远是 password，浏览器不会记、不会自动填。 */
function Field({
  id,
  name,
  label,
  hint,
  placeholder,
  secret,
}: {
  id: string
  name: string
  label: string
  hint?: string
  placeholder?: string
  secret?: boolean
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        {hint === undefined ? null : <Hint text={hint} />}
      </div>
      <Input
        id={id}
        name={name}
        type={secret === true ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        data-secret={secret === true ? 'true' : 'false'}
        data-1p-ignore={secret === true ? 'true' : undefined}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
    </div>
  )
}
