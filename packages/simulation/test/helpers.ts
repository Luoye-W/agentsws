import { fileURLToPath } from 'node:url'
import type { Evidence, Pack, ScenarioReport } from '../src/index.js'
import { loadPack, loadScenario, runScenario } from '../src/index.js'

/** 仓库根（test 目录往上两级到包，再两级到仓库根）。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const PACK_DIR = `${REPO_ROOT}packs/dtc-3c-3p`
export const HIDDEN_DIR = `${REPO_ROOT}packages/simulation/hidden`

let cached: Pack | undefined
export function pack(): Pack {
  if (cached === undefined) cached = loadPack(PACK_DIR)
  return cached
}

export interface RunOut {
  report: ScenarioReport
  evidence: Evidence
}

/** 跑 pack 里的一条场景，同时拿回证据。 */
export async function runPackScenario(rel: string, seed?: number): Promise<RunOut> {
  return runFile(`${PACK_DIR}/scenarios/${rel}`, seed)
}

export async function runHiddenScenario(rel: string, seed?: number): Promise<RunOut> {
  return runFile(`${HIDDEN_DIR}/${rel}`, seed)
}

export async function runFile(file: string, seed?: number): Promise<RunOut> {
  const scenario = loadScenario(file)
  let evidence: Evidence | undefined
  const report = await runScenario(scenario, {
    pack: pack(),
    captureEvidence: (e) => {
      evidence = e
    },
    ...(seed === undefined ? {} : { seed }),
  })
  if (evidence === undefined) throw new Error('没有拿到证据')
  return { report, evidence }
}

/** 事件序列的可比对指纹：类型 + 时刻 + 规范化后的载荷（不含随机 id）。 */
export function fingerprint(evidence: Evidence): string[] {
  return evidence.events.map((e) => `${e.type}@${e.at}`)
}

export const PACK_SCENARIOS = [
  'aftersales/return-within-window.yml',
  'aftersales/return-outside-window.yml',
  'security/injected-instruction.yml',
  'security/injected-instruction-control.yml',
  'ops/model-outage.yml',
  'ops/budget-exhausted.yml',
] as const
