# WP282 按人看积分（开源侧，接 WP279 私有云；决策 281 / 286–290）

worktree `../agentsws-wt/wp282-memberusage` · 分支 `wp/282-memberusage`（从 main 新起）。私有云 WP279 已上线：`GET /v1/wallet/usage?group=member`（可选 `member`、`month=YYYY-MM`）。先读 `docs/briefs/reports/WP276.md`（§3 第 6 条按人用量现状）、`docs/95` §8 第 7 条、`_common.md`。下面是私有云报告里给开源仓的配合清单（照做）：

## 4. 开源仓配合清单（本单没改开源仓，交开源仓下一单）

1. **契约**（`packages/contracts/src/cloud-entry.ts`、`cloud-api.ts`，只加不改）：
   - `UsageGroup` 加 `'member'`；
   - `WalletUsageQuery` 加 `member?: string`（本机成员 id，`attributionIdOk` 形状）、`month?: string`（`YYYY-MM`，公司时区，和 `from` / `to` 二选一）；缺省说明补一句「`group=member` 缺省按公司时区的本月」；
   - 新类型照 1.1 的回包：`MemberUsageBlock { credits; calls }`、`MemberUsageRow extends UsageRow { name?; blocks: Record<PricingBlock, MemberUsageBlock> }`、`MemberUsageReport { group: 'member'; from; to; timezone?; rows; unattributed: { credits; quantity; calls; blocks }; total_credits }`；路由的 `ok` 回包类型改成 `UsageReport | MemberUsageReport`（或者按人另立一个 body 类型）；
   - 重出 `cloud-openapi.json`（`gen-cloud-contract`）、SDK、ontology。开源仓合了以后，私有仓把 `member-usage.ts` 里本地定义的这几个类型换成 import 契约（另起一个私有仓小单，几行的事）。
   - `MeteringEvent` **不用动**：归属两格是云上本地的（同 `via`）。
2. **本机服务**（`apps/server`）：云客户端加 `usageByMember({ month?, from?, to?, member? })`；本机路由（例如 `GET /v1/cloud/usage/members`）按模式判权限：② 谁都看全员；③ owner / admin 看全员，其他人本机强制带 `member=<自己>`；① 只有自己。没关联云账号时照旧显示本机的次数 / token。
3. **替身云 `cloud-stand-in`**：支持 `group=member`、`member`、`month`，demo 种几条带归属的用量。
4. **工作台**：② 团队页（以及设置 → 积分）把按人用量从「本机次数 / token」（WP276 §3 第 6 条）换成云上的积分（三块 + 次数），「没标注」单独一行；没用量的同事由本机按名册补 0 行（云上只回有用量的人）。
5. **归属头要带全**：WP194 已经让模型 / 搜索数据 / 公共红人库这几条打云时都带上 `X-Agentsws-Member`。之后新加的打云路径也要带，不带的就落进「没标注」。


## Luoye 已定（286–290）
- 「本月」按公司时区（默认北京时间）；老分组仍 UTC。
- 上线前的老用量不回填：「没标注」那行加 tooltip「上线前的用量没按人记」。
- ③「成员只看自己」判在本机（上面第 2 条）。
- 按人用量用价目表三块（AI / 数据 / 服务）；额度页四格不动。
- 云上只回有用量的人，本机按名册补 0。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不调真实付费 API。另有子代理在做 WP281（删数据不出境，涉及 models / settings 文案）——尽量不动它的文件；合并前若 main 有新提交，先合 main、`npx tsc -b` 后再重出 gen-sdk / gen-ontology。界面少字。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `gen-cloud-contract --check`（契约改了要和私有云对得上：私有云 main 的路由形状以 `~/Documents/agentsws-cloud` 为准，只读）+ `open-repo-boundary`；截图 `docs/assets/wp282/`（② 团队页按人积分、③ 普通成员只看自己）；报告 `docs/briefs/reports/WP282.md`，要 Luoye 定的事单列、每条附建议。
