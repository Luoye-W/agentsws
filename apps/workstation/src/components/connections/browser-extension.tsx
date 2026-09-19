/**
 * 连接页的「浏览器插件」一节（WP119 / 68 定论 2）。
 *
 * 用户在这里做三件事：生成一个 6 位配对码、看已经配上的浏览器、撤掉其中一把。
 *
 * 界面上的四条：
 *
 * 1. **码大、清楚、带倒计时**。用户要用眼睛读它、用手在另一个窗口里打出来，
 *    所以它是这一节最大的东西，而且明说"5 分钟内有效、只能用一次"。
 * 2. **码不留痕**。生成那一次的响应里出现一次，显示在屏幕上，然后就没了——
 *    不写 localStorage、不进 URL、刷新一下就得重新生成。
 * 3. **撤销看得见**。撤掉的那一把**留在清单上**并标着撤销时间，而不是消失。
 *    用户要能回答"我上周是不是撤过一个"。
 * 4. **说清楚插件能干什么**。三个动作写在卡片上：看红人、收红人、读你的红人库。
 *    它**不能**发信、不能改合作、不能动订单——这一句比一串 scope 名管用。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Puzzle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import {
  createExtensionPairing,
  type ExtensionTokenView,
  listExtensionTokens,
  revokeExtensionToken,
} from '@/lib/api'

/** 码的有效期（与本机服务那一侧的 `PAIRING_TTL_MS` 是同一个数）。 */
const PAIRING_TTL_MS = 5 * 60 * 1000

function secondsLeft(expires_at: string, now: number): number {
  return Math.max(0, Math.round((Date.parse(expires_at) - now) / 1000))
}

function mmss(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function whenText(value: string | undefined): string {
  if (value === undefined) return '还没用过'
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return '还没用过'
  return new Date(at).toLocaleString('zh-CN', { hour12: false })
}

export function BrowserExtensionSection(props: { assignment?: string }): React.ReactNode {
  const client = useQueryClient()
  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | undefined>(
    undefined,
  )
  const [now, setNow] = useState(() => Date.now())

  const tokens = useQuery({
    queryKey: ['extension-tokens', props.assignment],
    queryFn: () => listExtensionTokens(props.assignment),
  })

  // 倒计时：码在屏幕上活多久，这一行就跑多久。到点自己消失（而不是留一个死码）。
  useEffect(() => {
    if (pairing === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])

  useEffect(() => {
    if (pairing === undefined) return
    if (secondsLeft(pairing.expires_at, now) > 0) return
    setPairing(undefined)
  }, [pairing, now])

  const generate = useMutation({
    mutationFn: () => createExtensionPairing(props.assignment),
    onSuccess: (out) => {
      setPairing(out)
      setNow(Date.now())
    },
  })

  const revoke = useMutation({
    mutationFn: (id: string) => revokeExtensionToken(id, props.assignment),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['extension-tokens'] })
    },
  })

  const rows = tokens.data?.tokens ?? []

  return (
    <section className="flex flex-col gap-2" data-testid="extension-section">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Puzzle className="size-4" aria-hidden />
        浏览器插件
      </h3>
      <p className="text-sm text-muted-foreground">
        「Agents 工坊 · 红人助手」装在 Chrome 里，在 YouTube / Instagram / TikTok
        页面上给红人做即时体检，你点一下就把他收进这个品牌的红人库。
        插件只能做三件事：看红人、收红人、读你的红人库——它发不了信、改不了合作、碰不到订单。
      </p>

      <div className="rounded-2xl bg-card p-4 shadow-[var(--ws-shadow)]">
        {pairing === undefined ? (
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              data-testid="extension-generate"
            >
              {generate.isPending ? '正在生成…' : '生成配对码'}
            </Button>
            {generate.isError ? (
              <p className="text-sm text-[var(--ws-bad)]" data-testid="extension-error">
                {(generate.error as Error).message}
              </p>
            ) : (
              <Hint text="生成之后去插件的设置页把那 6 位数字填进去。码 5 分钟内有效，只能用一次。" />
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2" data-testid="extension-code">
            <div className="font-mono text-4xl tracking-[0.35em] text-[var(--ws-ink)]">
              {pairing.code}
            </div>
            <p className="text-sm text-muted-foreground">
              还剩 {mmss(secondsLeft(pairing.expires_at, now))}。
              去插件设置页填进去；关掉这一页它就没了，到时候再生成一个就是。
            </p>
            <div>
              <Button variant="ghost" onClick={() => setPairing(undefined)}>
                收起来
              </Button>
            </div>
          </div>
        )}
      </div>

      {tokens.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="extension-empty">
          还没有哪个浏览器配上来。
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="extension-tokens">
          {rows.map((row) => (
            <TokenRow
              key={row.id}
              token={row}
              busy={revoke.isPending && revoke.variables === row.id}
              onRevoke={() => {
                if (!globalThis.confirm('撤掉之后那个浏览器就再也传不进来了。确定？')) return
                revoke.mutate(row.id)
              }}
            />
          ))}
        </ul>
      )}
      <Hint
        text={`码的有效期是 ${PAIRING_TTL_MS / 60000} 分钟。插件只连这台电脑上的 127.0.0.1，配对之后也是——它不认识任何云端地址。`}
      />
    </section>
  )
}

function TokenRow(props: {
  token: ExtensionTokenView
  busy: boolean
  onRevoke: () => void
}): React.ReactNode {
  const revoked = props.token.revoked_at !== undefined
  return (
    <li className="flex items-center gap-3 rounded-2xl bg-card p-3 shadow-[var(--ws-shadow)]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[var(--ws-ink)]">
          {props.token.label}
          {revoked ? <span className="ml-2 text-xs text-muted-foreground">已撤销</span> : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          扩展 {props.token.extension_id} · 最近用过：{whenText(props.token.last_used_at)}
          {revoked ? ` · 撤于 ${whenText(props.token.revoked_at)}` : ''}
        </div>
      </div>
      {revoked ? null : (
        <Button variant="ghost" onClick={props.onRevoke} disabled={props.busy}>
          {props.busy ? '正在撤…' : '撤掉'}
        </Button>
      )}
    </li>
  )
}
