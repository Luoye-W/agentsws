/**
 * WP336（决策 810–812）：AI 回话里的 genui 块交给 dsh-genui 的 `/embed` 渲染层画。单独一块（`lazy` 引进来），
 * 没有 genui 的页面不下载它。描述已经在契约里按白名单过滤过；这里再过一遍插件自己的 `processGenuiSpec`，画不了回退路。
 *
 * WP341（决策 847）：**完全融合**——
 * - 包一层 `GenuiActionContext`，动作交给**工坊自己的处理器**（契约 `resolveGenuiAction`）：发一句话 / 交表单（结构化
 *   回话）进当前对话、开页面 / 第三栏、开连接卡、调工具（事项里走工具执行器：只读的当场画结果，会改外部的出卡挂进时间线）。
 *   插件自己不发任何请求。这段对话不收话（`say` 没给）就不包——按钮照旧是禁用的。
 * - 口令格 / 「点开看」的外部媒体是宿主自己画的（`host-nodes.tsx`）；日期 / 数字两种格子在插件校验之后接回去。
 * - 链接一律外部浏览器打开（站内 `/…` 走路由），悬停显示真实域名。
 * - 有 echart / mermaid / scene3d 才去拉本机打包的那个引擎（登记到插件约定的位置，不插外部 `<script>`）。
 * - 交互状态不写本机存储。
 */
import {
  type GenuiDispatch,
  type GenuiSpecLite,
  type GenuiToolOutcome,
  genuiNodes,
  genuiUrlHost,
  resolveGenuiAction,
} from '@agentsws/contracts'
import {
  GenuiActionContext,
  GenuiBlock,
  type GenuiSpec,
  isRenderableProcess,
  processGenuiSpec,
} from '@changfenhuang/dsh-genui/embed'
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { openExternal } from '@/components/connections/bridge'
import { useRailState } from '@/components/rail/rail-state'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { runGenuiSetup, runGenuiTool } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { useGenuiHost } from './genui-host'
import { MediaGateNode, SECRET_DONE_ACTION, SecretNode } from './host-nodes'
import { registerHostGenuiComponent } from './primitives-shim'
import { ToolResult } from './tool-result'
import './genui-view.css'

registerHostGenuiComponent('ws-secret', SecretNode)
registerHostGenuiComponent('ws-media', MediaGateNode)

type Engine = 'echart' | 'mermaid' | 'scene3d'
const engines: Partial<Record<Engine, Promise<unknown>>> = {}
const loadEngine = (e: Engine): Promise<unknown> => {
  engines[e] ??=
    e === 'echart'
      ? import('./echarts-asset')
      : e === 'mermaid'
        ? import('./mermaid-asset')
        : import('./three-asset')
  return engines[e] as Promise<unknown>
}

const keepNothing = (): void => {}

/** 插件校验只认 text / email / color：日期 / 数字两种交给它之前先当 text（画之前再接回去）。 */
function forPlugin(spec: GenuiSpecLite): GenuiSpecLite {
  if (!genuiNodes(spec).some((n) => n.inputType === 'date' || n.inputType === 'number')) return spec
  const copy = structuredClone(spec)
  for (const n of genuiNodes(copy))
    if (n.inputType === 'date' || n.inputType === 'number') n.inputType = 'text'
  return copy
}

/** 日期 / 数字两种在插件校验之后按格子 id 接回去（插件照原生 `<input type>` 画）。 */
function withHostInputTypes(rendered: GenuiSpec, spec: GenuiSpecLite): GenuiSpec {
  const kinds = new Map<string, string>()
  for (const n of genuiNodes(spec))
    if (
      n.type === 'input' &&
      typeof n.id === 'string' &&
      (n.inputType === 'date' || n.inputType === 'number')
    )
      kinds.set(n.id, n.inputType)
  if (kinds.size === 0) return rendered
  const copy = structuredClone(rendered)
  for (const n of genuiNodes(copy as GenuiSpecLite)) {
    const kind = typeof n.id === 'string' ? kinds.get(n.id) : undefined
    if (n.type === 'input' && kind !== undefined) n.inputType = kind
  }
  return copy
}

interface ToolState {
  label: string
  outcome?: GenuiToolOutcome
  error?: string
}

export default function GenuiView({
  spec,
  fallback,
}: {
  spec: GenuiSpecLite
  fallback: ReactNode
}): ReactNode {
  const { t } = useApp()
  const host = useGenuiHost()
  const navigate = useNavigate()
  const rail = useRailState()
  const openConnect = useOpenConnect()
  const processed = useMemo(() => processGenuiSpec(forPlugin(spec)), [spec])
  const rendered = useMemo(
    () => (processed.spec === null ? null : withHostInputTypes(processed.spec, spec)),
    [processed, spec],
  )
  const nodes = useMemo(() => genuiNodes(spec), [spec])
  const need = useMemo(
    () =>
      (['echart', 'mermaid', 'scene3d'] as const).filter((e) => nodes.some((n) => n.type === e)),
    [nodes],
  )
  const [ready, setReady] = useState<'yes' | 'no' | 'failed'>(need.length > 0 ? 'no' : 'yes')
  useEffect(() => {
    if (need.length === 0) return
    let live = true
    Promise.all(need.map(loadEngine)).then(
      () => live && setReady('yes'),
      () => live && setReady('failed'),
    )
    return () => {
      live = false
    }
  }, [need])

  // 口令格填好的那几格（只有名字）；交表单时随结构化回话带上「已填好」
  const secrets = useRef<string[]>([])
  const hasSubmit = useMemo(() => nodes.some((n) => n.type === 'submit'), [nodes])
  const [tool, setTool] = useState<ToolState | undefined>(undefined)

  const runTool = useCallback(
    (d: Extract<GenuiDispatch, { kind: 'tool' }>): void => {
      if (host.matterId === undefined) {
        // 没有工具执行器的对话（随便聊、问 AI…）：把按钮那句话发进对话，让 AI 去做
        host.say?.(d.label)
        return
      }
      setTool({ label: d.label })
      runGenuiTool(host.matterId, {
        tool: d.tool,
        args: d.args,
        label: d.label,
        ...(host.runId === undefined ? {} : { run_id: host.runId }),
      }).then(
        (outcome) => {
          setTool({ label: d.label, outcome })
          host.onToolDone?.()
        },
        (e: unknown) =>
          setTool({ label: d.label, error: e instanceof Error ? e.message : String(e) }),
      )
    },
    [host],
  )

  const handler = useCallback(
    (action: string, payload: Record<string, unknown>): void => {
      if (action === SECRET_DONE_ACTION) {
        const label = typeof payload.label === 'string' ? payload.label : '口令'
        if (!secrets.current.includes(label)) secrets.current = [...secrets.current, label]
        // 单独一格（块里没有提交按钮）：填好就告诉 AI 一声（只有名字）
        if (!hasSubmit) host.say?.(`${label}：已填好`)
        return
      }
      if (host.busy === true) return
      const d = resolveGenuiAction(spec, action, payload, secrets.current)
      switch (d.kind) {
        case 'say':
        case 'reply':
          host.say?.(d.text)
          return
        case 'open':
          if (d.to.startsWith('agentsws://')) {
            if (!rail.openAddress(d.to)) void navigate('/')
          } else void navigate(d.to)
          return
        case 'connect':
          openConnect(d.services)
          return
        case 'setup': {
          const label = typeof payload.label === 'string' ? payload.label : d.target
          // WP348（决策 892）：事项 / 线程里就地出同一张方案卡（工坊先查一遍）；没有事项的地方交给 AI 去要
          if (host.matterId === undefined) {
            host.say?.(label)
            return
          }
          setTool({ label })
          runGenuiSetup(host.matterId, { target: d.target, label }).then(
            (out) => {
              setTool(undefined)
              if (out.status === 'unknown') host.say?.(label)
              host.onToolDone?.()
            },
            (e: unknown) => setTool({ label, error: e instanceof Error ? e.message : String(e) }),
          )
          return
        }
        case 'tool':
          runTool(d)
          return
        case 'none':
          return
      }
    },
    [spec, host, hasSubmit, rail, navigate, openConnect, runTool],
  )

  /** 链接：站内走路由、外部用浏览器打开；悬停显示真实域名。 */
  const onLinkClick = useCallback(
    (e: MouseEvent<HTMLDivElement>): void => {
      const a = (e.target as HTMLElement).closest?.('a[href]')
      if (!(a instanceof HTMLAnchorElement)) return
      const href = a.getAttribute('href') ?? ''
      e.preventDefault()
      e.stopPropagation()
      if (href.startsWith('/') && !href.startsWith('//')) void navigate(href)
      else if (/^(?:https?:|mailto:)/iu.test(href)) openExternal(href)
    },
    [navigate],
  )
  const onLinkHover = useCallback(
    (e: { target: EventTarget }): void => {
      const a = (e.target as HTMLElement).closest?.('a[href]')
      if (!(a instanceof HTMLAnchorElement) || a.dataset.host !== undefined) return
      const href = a.getAttribute('href') ?? ''
      const where = genuiUrlHost(href) ?? (href.startsWith('mailto:') ? href.slice(7) : href)
      a.dataset.host = where
      a.title = t('genui.link.open', { host: where })
    },
    [t],
  )

  if (rendered === null || !isRenderableProcess(processed) || ready === 'failed') return fallback
  if (ready === 'no') return <div className="min-h-[120px]" data-testid="answer-genui-loading" />
  const block = <GenuiBlock spec={rendered} animateEntrance={false} onStateChange={keepNothing} />
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 只接住里面链接的点击 / 悬停（链接本身可聚焦）
    <div
      className="ws-genui"
      data-testid="answer-genui"
      data-interactive={host.say === undefined ? 'false' : 'true'}
      onClickCapture={onLinkClick}
      onMouseOver={onLinkHover}
      onFocus={onLinkHover}
    >
      {host.say === undefined ? (
        block
      ) : (
        <GenuiActionContext.Provider value={handler}>{block}</GenuiActionContext.Provider>
      )}
      {tool === undefined ? null : <ToolResult {...tool} />}
    </div>
  )
}
