/**
 * WP324（决策 690）：**一张连接卡上的一样**怎么就地连——与连接页同一条路（`begin` → 授权页轮询 / 本机原生表单
 * `submit`），只是收成一个 hook，卡里、第三栏里都能用。连接页本身不动（它是总览与管理）。
 *
 * 凭据这条线照连接页的纪律：表单值从 `SecureForm` 的 FormData 出来 → `submitConnection` → 结束；
 * 这里没有一处把它放进 state、query 缓存、URL、日志，更不经卡、不经 AI。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { openExternal } from '@/components/connections/bridge'
import type { WizardPhase } from '@/components/connections/provider-card'
import type { ConnectTestResult, ProviderFieldSpec, ProviderView } from '@/lib/api'
import {
  beginConnect,
  getPositions,
  listConnections,
  listProviders,
  pollConnectRequest,
  submitConnection,
} from '@/lib/api'
import { useMode } from '@/lib/mode'

const POLL_MS = 2000
const POLL_LIMIT = 150

/**
 * 连接用哪条分配（与连接页同一把尺子：连接是所有者的事；② 同事互联里谁接的谁管，用自己任意一条）。
 * `undefined` = 这个人管不了连接（卡上照实说一句）。
 */
export function useConnectAssignment(): { assignment: string | undefined; ready: boolean } {
  const { mode } = useMode()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const owner = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const assignment =
    owner ?? (mode === 'peers' ? positions.data?.positions[0]?.position_id : undefined)
  return { assignment, ready: positions.data !== undefined }
}

/** 连接目录与已连清单（与连接页同一个 query key：连上 / 断开两边一起变）。 */
export function useConnectionState(assignment: string | undefined): {
  providers: ProviderView[] | undefined
  isConnected: (service: string) => boolean
  refresh: () => void
} {
  const client = useQueryClient()
  const enabled = assignment !== undefined
  const providers = useQuery({
    queryKey: ['connect-providers', assignment],
    enabled,
    queryFn: () => listProviders(assignment),
  })
  const connections = useQuery({
    queryKey: ['connections', assignment],
    enabled,
    queryFn: () => listConnections(assignment),
  })
  const refresh = useCallback((): void => {
    void client.invalidateQueries({ queryKey: ['connections'] })
    void client.invalidateQueries({ queryKey: ['connect-providers'] })
    void client.invalidateQueries({ queryKey: ['home'] })
    void client.invalidateQueries({ queryKey: ['view'] })
  }, [client])
  const rows = connections.data?.connections ?? []
  return {
    providers: providers.data?.providers,
    isConnected: (service) => rows.some((c) => c.service === service && c.status === 'active'),
    refresh,
  }
}

export interface ConnectFlow {
  phase: WizardPhase
  fields: ProviderFieldSpec[] | undefined
  oauthUrl: string | undefined
  result: ConnectTestResult | undefined
  start: () => void
  cancel: () => void
  /** 唯一出口：值只在这一次调用里存在。 */
  submit: (values: Record<string, string>) => void
}

/** 一个 provider 的就地连接（OAuth 授权页 / 本机原生表单）。连上了叫 `onConnected`。 */
export function useConnectFlow(
  service: string,
  assignment: string | undefined,
  onConnected: () => void,
): ConnectFlow {
  const [phase, setPhase] = useState<WizardPhase>('idle')
  const [fields, setFields] = useState<ProviderFieldSpec[] | undefined>(undefined)
  const [oauthUrl, setOauthUrl] = useState<string | undefined>(undefined)
  const [result, setResult] = useState<ConnectTestResult | undefined>(undefined)
  const request = useRef<{ id?: string; auth_option?: string }>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stop = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  useEffect(() => stop, [stop])

  const fail = (detail: string, reason?: string): void => {
    setResult({
      ok: false,
      detail,
      ...(reason === undefined ? {} : { reason }),
      checked_at: new Date().toISOString(),
    })
  }

  const poll = (request_id: string): void => {
    let tries = 0
    const tick = async (): Promise<void> => {
      tries += 1
      try {
        const out = await pollConnectRequest(request_id, assignment)
        if (out.status === 'connected') {
          setPhase('idle')
          onConnected()
          return
        }
        if (out.status !== 'initiated') {
          setPhase('idle')
          fail(out.status, out.status)
          return
        }
      } catch {
        // 网络抖一下不打断，下一轮接着来
      }
      if (tries >= POLL_LIMIT) {
        setPhase('idle')
        return
      }
      timer.current = setTimeout(() => void tick(), POLL_MS)
    }
    timer.current = setTimeout(() => void tick(), POLL_MS)
  }

  const begin = useMutation({
    mutationFn: () => beginConnect(service, {}, assignment),
    onSuccess: (out) => {
      request.current = { id: out.request_id }
      if (out.authorization_url !== undefined) {
        openExternal(out.authorization_url)
        setOauthUrl(out.authorization_url)
        setPhase('authorizing')
        poll(out.request_id)
        return
      }
      const chosen = out.secure_form?.auth_option
      if (chosen !== undefined) request.current.auth_option = chosen
      setFields(out.secure_form?.fields)
      setPhase('form')
    },
    onError: (e: Error) => fail(e.message),
  })

  const save = useMutation({
    mutationFn: (values: Record<string, string>) =>
      submitConnection(
        service,
        {
          fields: values,
          ...(request.current.id === undefined ? {} : { request_id: request.current.id }),
          ...(request.current.auth_option === undefined
            ? {}
            : { auth_option: request.current.auth_option }),
        },
        assignment,
      ),
    onSuccess: (out) => {
      setResult(out.test)
      setPhase('idle')
      if (out.test.ok) onConnected()
    },
    onError: (e: Error) => {
      // 只记错误那一句，不回显任何填的值；表单留着改一改再交
      fail(e.message)
      setPhase('form')
    },
  })

  return {
    phase,
    fields,
    oauthUrl,
    result,
    start: () => {
      setResult(undefined)
      begin.mutate()
    },
    cancel: () => {
      stop()
      setPhase('idle')
    },
    submit: (values) => {
      setPhase('saving')
      save.mutate(values)
    },
  }
}
