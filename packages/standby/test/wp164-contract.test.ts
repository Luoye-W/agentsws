/**
 * WP164：在线值守那一组路由 ↔ 云端对外契约（`packages/contracts/cloud-openapi.json`）。
 *
 * 值守只在自建 / Node 形态的云上挂（Workers 形态没有常驻子进程），所以它不在
 * `apps/cloud-worker/test/wp164-contract.test.ts` 那一趟里，在这里单独核：
 * 真的路由包 + 真的 `StandbyService`，子进程 / 文件系统 / 打包器是 `helpers.ts` 的替身。
 * 校验器与那边同一份（`apps/cloud-worker/test/contract/conformance.ts`）。
 */
import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  ContractRecorder,
  loadCloudContract,
} from '../../../apps/cloud-worker/test/contract/conformance.js'
import { createStandbyApp, type StandbyEnv, type StandbyVerifier } from '../src/index.js'
import { harness } from './helpers.js'

const MERCHANT = 'wst_merchant'
const NO_STANDBY = 'wst_no_standby'

const verifier: StandbyVerifier = (token) => {
  const base = { account_id: 'acc_1', org_id: 'org_1', workspace_id: 'ws_1' }
  if (token === MERCHANT) return Promise.resolve({ ...base, scopes: ['ai', 'standby'] })
  if (token === NO_STANDBY) return Promise.resolve({ ...base, scopes: ['ai'] })
  return Promise.resolve(undefined)
}

const rec = new ContractRecorder(loadCloudContract())

async function hit(
  app: Hono<StandbyEnv>,
  path: string,
  init: { method?: string; token?: string; body?: unknown; zip?: Uint8Array } = {},
): Promise<number> {
  const headers: Record<string, string> = {}
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.zip !== undefined) headers['content-type'] = 'application/zip'
  const method = init.method ?? 'GET'
  const res = await app.request(path, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.zip === undefined ? {} : { body: init.zip }),
  })
  await rec.check(method, path, res)
  return res.status
}

describe('WP164 契约 ↔ 在线值守', () => {
  it('列、开、看、停、导入、导出；401 / 403 / 404 / 402 / 422 都在契约里', async () => {
    const h = harness({ credits: 1000 })
    const app = createStandbyApp({ service: h.service, verifier })
    expect(await hit(app, '/v1/standby/workspaces', { token: MERCHANT })).toBe(200)
    expect(await hit(app, '/v1/standby/workspaces')).toBe(401)
    expect(await hit(app, '/v1/standby/workspaces', { token: NO_STANDBY })).toBe(403)
    expect(await hit(app, '/v1/standby/workspaces/ws_1', { token: MERCHANT })).toBe(404)
    expect(await hit(app, '/v1/standby/workspaces/ws_2', { token: MERCHANT })).toBe(403)
    expect(
      await hit(app, '/v1/standby/workspaces', {
        method: 'POST',
        token: MERCHANT,
        body: { seats: 1 },
      }),
    ).toBe(201)
    expect(await hit(app, '/v1/standby/workspaces/ws_1', { token: MERCHANT })).toBe(200)
    expect(
      await hit(app, '/v1/standby/workspaces/ws_1/stop', { method: 'POST', token: MERCHANT }),
    ).toBe(200)
    h.fs.dirs.set('/data/standby/ws_1', 5)
    expect(await hit(app, '/v1/standby/workspaces/ws_1/export', { token: MERCHANT })).toBe(200)
    expect(
      await hit(app, '/v1/standby/workspaces/ws_1/import?seats=1&force=true', {
        method: 'POST',
        token: MERCHANT,
        zip: new Uint8Array([80, 75, 3, 4]),
      }),
    ).toBe(201)

    const broke = harness({ credits: 0 })
    expect(
      await hit(createStandbyApp({ service: broke.service, verifier }), '/v1/standby/workspaces', {
        method: 'POST',
        token: MERCHANT,
        body: { seats: 1 },
      }),
    ).toBe(402)
    const bad = harness({ credits: 1000, packageOk: false })
    expect(
      await hit(
        createStandbyApp({ service: bad.service, verifier }),
        '/v1/standby/workspaces/ws_1/import?seats=1',
        { method: 'POST', token: MERCHANT, zip: new Uint8Array([80, 75, 3, 4]) },
      ),
    ).toBe(422)
    expect(rec.missingSuccess(['standby'])).toEqual([])
  })
})
