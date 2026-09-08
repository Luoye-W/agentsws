/**
 * preset = 一职责一目录（16 §1）：`<root>/<role_id>/agent.cordis.yml` + `preset.yml`。
 *
 * 适配器按 RunRequest 生成它。同进程运行时我们直接装门禁插件；
 * 生成的目录是**同一份组合的跨进程形态**——`dsh --profile agentsws-executor` 用它起 headless run，
 * 组合内容与同进程装的完全一致（一份定义，两种宿主）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRequest } from '@agentsws/contracts'
import { canonicalJson, sha256 } from '@agentsws/core'
import { stringify } from 'yaml'
import { GATEWAY_PROVIDER } from './llm.js'

/** 门禁插件在 preset 里的模块名（跨进程时由 profile 的 node_modules 解析）。 */
export const GATE_PLUGIN_MODULE = '@agentsws/dsh-adapter/preset-gate'

export interface PresetPaths {
  dir: string
  composition: string
  manifest: string
}

export interface PresetComposition {
  rows: unknown[]
  manifest: Record<string, unknown>
}

/** 一次运行的 preset 组合（纯函数，契约测试直接断言它）。 */
export function presetComposition(req: RunRequest): PresetComposition {
  const rows = [
    {
      id: 'agentsws-gate',
      name: GATE_PLUGIN_MODULE,
      config: {
        role_id: req.actor.role_id,
        preset: req.runtime.preset,
        workspace_id: req.workspace_id,
        tools: {
          allow: [...req.tools.allow].sort(),
          side_effect_policy: req.tools.side_effect_policy,
        },
        // 16 §2：公司端 preset 的 systemPrompt 白名单——persona 是 complete 段
        system_prompt: { persona_complete: true },
      },
    },
    {
      id: 'agentsws-llm',
      name: '@agentsws/dsh-adapter/preset-llm',
      config: { provider: GATEWAY_PROVIDER, model: req.runtime.model.model },
    },
  ]
  return {
    rows,
    manifest: {
      name: `agentsws ${req.actor.role_id}`,
      description: `agentsws 职责 preset（${req.actor.role_id}），由 dsh-adapter 按 RunRequest 生成`,
    },
  }
}

const HEADER = [
  '# 由 @agentsws/dsh-adapter 生成，请勿手改。',
  '# 一职责一 preset（16 §1）；工具集由 RunRequest.tools.allow 决定（tools.restrict 默认拒绝）。',
  '',
].join('\n')

/**
 * 把 preset 写到磁盘。`root` 省略时写进程临时目录下的 `agentsws-dsh-presets/<hash>`，
 * hash 只由组合内容决定 —— 同一份 RunRequest 生成同一个目录，不随运行次数增长。
 */
export function writePreset(req: RunRequest, root?: string): PresetPaths {
  const comp = presetComposition(req)
  const digest = sha256(canonicalJson(comp)).slice(0, 16)
  const base = root ?? join(tmpdir(), 'agentsws-dsh-presets', digest)
  const dir = join(base, req.actor.role_id)
  mkdirSync(dir, { recursive: true })
  const composition = join(dir, 'agent.cordis.yml')
  const manifest = join(dir, 'preset.yml')
  writeFileSync(composition, HEADER + stringify(comp.rows), 'utf8')
  writeFileSync(manifest, HEADER + stringify(comp.manifest), 'utf8')
  return { dir, composition, manifest }
}
