# packs

合成公司数据集（docs/26 §2）。**同一份数据既是 demo 数据、上手引导数据，也是回归基线**；
验收另用隐藏场景集（`packages/simulation/hidden/`，31 §1 I9），不在这里。

| pack | 规模 | 生成命令 | 用途 |
|---|---|---|---|
| `dtc-3c-3p` | 3 人、1 家店、50 单 | `pnpm synth --size 3` | 合并门禁（每次提交跑 fast 档）、demo、README 的 30 分钟路径 |
| `dtc-15p` | 15 人、2 家店、150 单，4 个岗位（售后 / 运营 / 投放 / 店主） | `pnpm synth --size 15` | 每夜 CI；多岗位并发、跨岗位交接、一人两岗位不并集 |
| `dtc-50p` | 50 人、3 家店、300 单 | `pnpm synth --size 50` | **不入库**（三百单的 YAML 没必要提交）：现生成、跑一条烟测，不进门禁 |

每个 pack 的目录形状（26 §2）：

```
manifest.yml            # schema_version / seed / anchor / sizes / soak 参数
workspace.yml  people.yml  assignments.yml  policy.yml
roles/*.yml             # pack 自带的职责定义（15 / 50 人才有；按 id 覆盖内置那三份）
store/ products.yml orders.yml customers.yml shipments.yml
threads/*.yml           # 邮件线程（含毒样本，必配 should-serve 对照）
creators.yml  campaigns.yml
knowledge/*.md          # 事实 / 话术 / 策略三层
skills/*.md             # 个人 overlay 示例
judge/*.md              # 评分标准：frontmatter 给规则 judge，正文给模型 judge
fixtures/*              # 来信正文
scenarios/**/*.yml      # 人写的回归题（生成器不动）
baseline.json           # 跑出来的指标基线，按运行时分档（生成器不动）
```

生成器只写它拥有的那些文件，**不动 `scenarios/`、`judge/` 与 `baseline.json`**——
场景是人写的回归题，基线是跑出来的。所以重生成不会毁掉断言。
