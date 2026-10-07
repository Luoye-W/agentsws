/**
 * WP254（决策 100 / 123）：下载源（官方源 / 国内源 npmmirror，每台机一份）的接口。
 *
 * 单独一个文件（`api.ts` 那张大表好几单同时在加）。
 */
import { api } from './api'

export type NpmRegistrySource = 'official' | 'npmmirror'

export interface NpmRegistryView {
  source: NpmRegistrySource
  urls: { official: string; npmmirror: string }
  /** 用户环境里自己设了 `npm_config_registry`。 */
  env_override: boolean
  updated_at?: string
}

export const getNpmRegistry = (): Promise<NpmRegistryView> => api('/v1/settings/npm-registry')

export const setNpmRegistry = (source: NpmRegistrySource): Promise<NpmRegistryView> =>
  api('/v1/settings/npm-registry', { method: 'PUT', body: { source } })

/** 失败那一行给不给「换国内源再试」：网络类失败（连不上 / 超时），而且这次用的不是国内源。 */
export function offerMirrorRetry(
  job:
    | { phase: string; error?: { code: string } | undefined; registry?: string | undefined }
    | undefined,
): boolean {
  if (job?.phase !== 'failed') return false
  const code = job.error?.code
  return (code === 'network' || code === 'timeout') && job.registry !== 'npmmirror'
}
