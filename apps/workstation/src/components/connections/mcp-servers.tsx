/**
 * 自定义 MCP 服务器（54（将改号 55）§4 目录里的那一条，WP83）。
 *
 * 本期只做**保存、校验与探测**：登记一台、连一次、把它报的工具列出来。
 * **不接进运行时**——把 MCP 服务器挂到 Agent 上是官方 `mcp-client` 按 preset 的事，
 * 那要等官方 Agent 层引进来（WP81）。界面上把这句话明写出来，
 * 免得有人登记完等着 AI 会用它。
 *
 * 凭据这条线与 `SecureForm` 同一条纪律（13 §4.3）：请求头的值多半是一枚 Bearer token，
 * 所以它走**原生 `<form>` + `FormData`**——值不进 React state、不进 query 缓存、
 * 不进 URL、提交完立刻 `form.reset()`。这个文件里没有一次 `console.*`。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SafetyNote } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { listMcpServers, probeMcpServer, removeMcpServer, saveMcpServer } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 一行一个 `名字: 值` → 对象。空行与没有冒号的行直接跳过。 */
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    const at = trimmed.indexOf(':')
    if (trimmed === '' || at <= 0) continue
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return out
}

export function McpServers({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const prefix = useId()
  const [adding, setAdding] = useState(false)
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('stdio')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const servers = useQuery({
    queryKey: ['mcp-servers', assignment],
    queryFn: () => listMcpServers(assignment),
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['mcp-servers'] })
    // 登记成功会把目录上那一条从"未连"变成"已连"
    void client.invalidateQueries({ queryKey: ['connection-directory'] })
  }

  const save = useMutation({
    mutationFn: (input: Parameters<typeof saveMcpServer>[0]) => saveMcpServer(input, assignment),
    onSuccess: () => {
      setFailure(undefined)
      setAdding(false)
      refresh()
    },
    onError: (error: Error) => {
      // 只记错误消息，不回显任何用户填的值
      setFailure(error.message)
    },
  })

  const probe = useMutation({
    mutationFn: (name: string) => probeMcpServer(name, assignment),
    onSettled: () => {
      setBusy(undefined)
      refresh()
    },
  })

  const remove = useMutation({
    mutationFn: (name: string) => removeMcpServer(name, assignment),
    onSettled: () => {
      setBusy(undefined)
      refresh()
    },
  })

  /** 提交：值只在这一次调用里存在（`FormData` → 入参 → 发出去 → `reset()`）。 */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const text = (name: string): string => String(values.get(name) ?? '').trim()
    const args = text('args')
    const headers = parseHeaders(String(values.get('headers') ?? ''))
    save.mutate({
      name: text('name'),
      transport,
      ...(transport === 'stdio'
        ? {
            command: text('command'),
            ...(args === '' ? {} : { args: args.split(/\s+/) }),
          }
        : { url: text('url') }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    })
    form.reset()
  }

  const rows = servers.data?.servers ?? []

  return (
    <div
      className="mt-2 flex flex-col gap-2 rounded-md border border-dashed p-2"
      data-testid="mcp-servers"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('connections.mcp.hint')}</p>
        <Button
          size="sm"
          variant={adding ? 'ghost' : 'outline'}
          data-testid="mcp-add"
          onClick={() => {
            setFailure(undefined)
            setAdding((v) => !v)
          }}
        >
          {adding ? t('connections.cancel') : t('connections.mcp.add')}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="mcp-empty">
          {t('connections.mcp.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.name}
              className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-2"
              data-testid="mcp-row"
              data-name={row.name}
            >
              <div className="min-w-0">
                <p className="text-sm">
                  {row.name}
                  <span className="ml-2 text-xs text-muted-foreground">{row.transport}</span>
                </p>
                {row.probe === undefined ? null : row.probe.ok ? (
                  <p className="text-xs text-muted-foreground" data-testid="mcp-tools">
                    {t('connections.mcp.tools', {
                      n: String(row.probe.tools.length),
                      names: row.probe.tools
                        .slice(0, 5)
                        .map((tool) => tool.name)
                        .join('、'),
                    })}
                  </p>
                ) : (
                  <p className="text-xs text-destructive" data-testid="mcp-failed">
                    {row.probe.detail ?? t('connections.mcp.failed')}
                  </p>
                )}
                {row.header_names.length === 0 ? null : (
                  <p className="text-xs text-muted-foreground">
                    {/* 只说存了哪几个头的**名字**——值在本机加密库里 */}
                    {t('connections.mcp.headers_stored', { names: row.header_names.join('、') })}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === row.name}
                  data-testid="mcp-probe"
                  onClick={() => {
                    setBusy(row.name)
                    probe.mutate(row.name)
                  }}
                >
                  {busy === row.name ? t('connections.testing') : t('connections.mcp.probe')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === row.name}
                  data-testid="mcp-remove"
                  onClick={() => {
                    if (!globalThis.confirm(t('connections.mcp.remove.confirm'))) return
                    setBusy(row.name)
                    remove.mutate(row.name)
                  }}
                >
                  {t('connections.mcp.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form className="flex flex-col gap-2" onSubmit={submit} data-testid="mcp-form">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${prefix}-name`}>{t('connections.mcp.name')}</Label>
            <Input id={`${prefix}-name`} name="name" required placeholder="my-tools" />
          </div>
          <fieldset className="flex flex-wrap items-center gap-3">
            <legend className="text-sm">{t('connections.mcp.transport')}</legend>
            {(['stdio', 'streamable-http'] as const).map((value) => (
              <label key={value} className="flex items-center gap-1 text-sm">
                <input
                  type="radio"
                  name="transport"
                  value={value}
                  checked={transport === value}
                  data-testid={`mcp-transport-${value}`}
                  onChange={() => {
                    setTransport(value)
                  }}
                />
                {value}
              </label>
            ))}
          </fieldset>
          {transport === 'stdio' ? (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${prefix}-command`}>{t('connections.mcp.command')}</Label>
                <Input id={`${prefix}-command`} name="command" required placeholder="npx" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${prefix}-args`}>{t('connections.mcp.args')}</Label>
                <Input id={`${prefix}-args`} name="args" placeholder="-y @scope/some-mcp-server" />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${prefix}-url`}>{t('connections.mcp.url')}</Label>
              <Input
                id={`${prefix}-url`}
                name="url"
                required
                placeholder="https://example.com/mcp"
              />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${prefix}-headers`}>{t('connections.mcp.headers')}</Label>
            <Textarea
              id={`${prefix}-headers`}
              name="headers"
              rows={2}
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              placeholder={'Authorization: Bearer …'}
            />
            <p className="text-xs text-muted-foreground">{t('connections.mcp.headers.hint')}</p>
          </div>
          <SafetyNote text={t('connections.never_ai')} />
          {failure === undefined ? null : (
            <p role="alert" className="text-sm text-destructive" data-testid="mcp-error">
              {failure}
            </p>
          )}
          <div>
            <Button size="sm" type="submit" disabled={save.isPending} data-testid="mcp-save">
              {save.isPending ? t('connections.saving') : t('connections.mcp.save')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
