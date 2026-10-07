/**
 * WP251：启动品牌挂到公司下（启动时一次，幂等）。
 *
 * Fable 10-07 Windows 真机：启动品牌 INMO 挂在公司下，但 `kind: personal`；加的品牌 Rollout 是 `kind: shared`。
 * 真机上要做的只有第 3 条（`kind` 口径统一）——工单最初以为 INMO 没有 `org_id`，Fable 复查更正。
 * 第 1、2 条是兜底：真遇到启动品牌没挂公司、负责人却已有公司的数据，也挂得进去。
 *
 * 只改身份库里工作区那一行，别的一个字节不动：
 *
 * 1. 启动品牌没有 `org_id`、而它的负责人已经是某家公司的所有者 → 挂到那家公司下
 *    （有几家就挑品牌最多的，一样多挑最早建的），`kind` 改成 `shared`（与「加一个品牌」建出来的一致）。
 *    负责人名下一家公司都没有 → 不动，交给原来那条迁移（`organizations.migrate`）用档案建一家。
 * 2. 挂进去之前，原来的公司默认品牌（那家公司的第一个品牌）**自己接了模型**的，先替它记下
 *    「用自己那一套」——启动品牌一挂进来就成了公司默认，不记的话它会悄悄改成跟随启动品牌。
 *    它自己没接模型的就不记：挂进来之后跟随公司（52 O3 的默认），能用上启动品牌那一份。
 * 3. 公司下有两个及以上品牌时，还是 `personal` 的那几个改成 `shared`（`kind` 只是口径，没有代码按它分叉）。
 *
 * 品牌的连接、岗位、事项、知识库都按 `workspace_id` 存在各自的目录 / 表里（52 O3），
 * 挂组织只改身份库里工作区那一行的 `org_id` 与 `kind`，所以它们一条都不会动。
 */
import type { Organization, Workspace, WorkspaceId } from '@agentsws/contracts'

export interface BootBrandOrgIdentity {
  getWorkspace(id: WorkspaceId): Promise<Workspace | undefined>
  listOrganizations(): Organization[]
  brandsOf(org_id: string): Workspace[]
  attachWorkspaceToOrg(input: {
    workspace_id: WorkspaceId
    org_id: string
    kind?: Workspace['kind']
  }): Promise<Workspace>
}

export interface BootBrandOrgOptions {
  identity: BootBrandOrgIdentity
  /** 启动品牌。 */
  workspace_id: WorkspaceId
  /** 这个品牌**自己**有没有接上模型（不看跟随）。 */
  ownModelsConfigured(workspace_id: WorkspaceId): Promise<boolean>
  /** 替这个品牌记下「不跟随公司、用自己那一套」（它此刻是公司默认也照记）。 */
  keepOwnModels(workspace_id: WorkspaceId): Promise<void>
  /** 留一条痕（只记 id，不记名字）。 */
  record?(type: string, workspace_id: WorkspaceId, payload: Record<string, unknown>): void
}

export interface BootBrandOrgResult {
  /** 这一次挂到了哪家公司（早就挂着 / 没有可挂的 = 没有）。 */
  attached?: string
  /** 改成 `shared` 的品牌。 */
  shared: WorkspaceId[]
  /** 替它记下「用自己那一套模型」的品牌。 */
  kept_own_models: WorkspaceId[]
}

/** 负责人名下的公司里挑一家：品牌最多的，一样多挑最早建的。 */
function pickCompany(identity: BootBrandOrgIdentity, owner_id: string): Organization | undefined {
  const mine = identity
    .listOrganizations()
    .filter(
      (o) =>
        o.owner_id === owner_id &&
        o.members.some(
          (m) => m.person_id === owner_id && m.role === 'owner' && m.left_at === undefined,
        ),
    )
  return mine.sort(
    (a, b) =>
      identity.brandsOf(b.id).length - identity.brandsOf(a.id).length ||
      a.created_at.localeCompare(b.created_at),
  )[0]
}

export async function attachBootBrandToCompany(
  options: BootBrandOrgOptions,
): Promise<BootBrandOrgResult> {
  const { identity } = options
  const out: BootBrandOrgResult = { shared: [], kept_own_models: [] }
  const boot = await identity.getWorkspace(options.workspace_id)
  if (boot === undefined) return out
  let org_id = boot.org_id
  if (org_id === undefined) {
    const company = pickCompany(identity, boot.owner_id)
    if (company === undefined) return out
    const first = identity.brandsOf(company.id)[0]
    if (
      first !== undefined &&
      first.id !== boot.id &&
      (await options.ownModelsConfigured(first.id))
    ) {
      await options.keepOwnModels(first.id)
      out.kept_own_models.push(first.id)
    }
    await identity.attachWorkspaceToOrg({
      workspace_id: boot.id,
      org_id: company.id,
      kind: 'shared',
    })
    if (boot.kind !== 'shared') out.shared.push(boot.id)
    out.attached = company.id
    org_id = company.id
    options.record?.('organization.brand_attached', boot.id, {
      organization_id: company.id,
      workspace_id: boot.id,
      reason: 'wp251_boot_brand_without_org',
      kept_own_models: out.kept_own_models,
    })
  }
  const brands = identity.brandsOf(org_id)
  if (brands.length >= 2) {
    for (const w of brands) {
      if (w.kind === 'shared') continue
      await identity.attachWorkspaceToOrg({ workspace_id: w.id, org_id, kind: 'shared' })
      if (!out.shared.includes(w.id)) out.shared.push(w.id)
    }
  }
  return out
}
