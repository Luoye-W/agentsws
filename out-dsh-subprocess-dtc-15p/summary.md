# 模拟回路报告 —— dtc-15p

**合并门禁：通过**｜19/19 场景通过｜fast 档｜dsh 运行时｜2026-09-07T04:00:00.000Z

## 场景

| 场景 | 结果 | 不变量 | 规则 judge | 模型 judge |
|---|---|---|---|---|
| `community/broadcast-respects-suppression` | ✓ | 3/3 | 1.000 | — |
| `ops/claim-pool` | ✓ | 5/5 | 1.000 | — |
| `ops/collision-two-people` | ✓ | 5/5 | 1.000 | — |
| `ops/cross-desk-handover` | ✓ | 5/5 | 1.000 | — |
| `ops/edit-product-price` | ✓ | 5/5 | 1.000 | — |
| `ops/multi-desk-concurrency` | ✓ | 6/6 | 1.000 | — |
| `ops/product-line-isolation` | ✓ | 5/5 | 1.000 | — |
| `ops/theme-publish-needs-approval` | ✓ | 5/5 | 1.000 | — |
| `ops/two-desks-no-union` | ✓ | 5/5 | 1.000 | — |
| `org/brand-adds-store` | ✓ | 5/5 | 1.000 | — |
| `org/task-opened-at-position-routes-to-duty` | ✓ | 5/5 | 1.000 | — |
| `org/two-brands-cannot-see-each-other` | ✓ | 5/5 | 1.000 | — |
| `org/two-solo-users-discover` | ✓ | 5/5 | 1.000 | — |
| `pr/subreddit-cooldown` | ✓ | 2/2 | 1.000 | — |
| `secretary/ask-colleague` | ✓ | 5/5 | 1.000 | — |
| `secretary/meet-conflict` | ✓ | 5/5 | 1.000 | — |
| `secretary/route-to-desk` | ✓ | 5/5 | 1.000 | — |
| `social/calendar-conflict-flagged` | ✓ | 3/3 | 1.000 | — |
| `store/daily-report-card` | ✓ | 3/3 | 1.000 | — |

## 指标（括号里是与基线的 delta）

| 场景 | adoption_rate | applied_changes | blocked_proposals | cost_base | escalations | expired_approvals | guardrail_hits | intervention_rate | judge_rule_score | knowledge_gaps | outbound_sent | queue_latency_ms | runs_failed | sampling_reviews | staged_changes | tokens_per_item | tool_calls |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `community/broadcast-respects-suppression` | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 |
| `ops/claim-pool` | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） |
| `ops/collision-two-people` | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） |
| `ops/cross-desk-handover` | 1（+0%） | 0（+0%） | 0（+0%） | 0.008089（+0%） | 4（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 8067（+0%） | 4（+0%） |
| `ops/edit-product-price` | 1（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 2（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 900000（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 6（+0%） |
| `ops/multi-desk-concurrency` | 1（+0%） | 1（+0%） | 0（+0%） | 0.022531（+0%） | 0（+0%） | 0（+0%） | 3（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 3（+0%） | 2520000（+0%） | 0（+0%） | 0（+0%） | 2（+0%） | 7486（+0%） | 11（+0%） |
| `ops/product-line-isolation` | 1（+0%） | 1（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 3（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 1200000（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 6（+0%） |
| `ops/theme-publish-needs-approval` | 1（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 2（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 2700000（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 1（+0%） |
| `ops/two-desks-no-union` | 1（+0%） | 1（+0%） | 0（+0%） | 0.008089（+0%） | 0（+0%） | 0（+0%） | 2（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 1（+0%） | 1650000（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 8067（+0%） | 4（+0%） |
| `org/brand-adds-store` | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 2400000（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） |
| `org/task-opened-at-position-routes-to-duty` | 1（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 2（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 1200000（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 3（+0%） |
| `org/two-brands-cannot-see-each-other` | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） |
| `org/two-solo-users-discover` | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 2400000（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） |
| `pr/subreddit-cooldown` | 1 | 0 | 1 | 0 | 0 | 0 | 4 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 2 |
| `secretary/ask-colleague` | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） |
| `secretary/meet-conflict` | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） |
| `secretary/route-to-desk` | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） |
| `social/calendar-conflict-flagged` | 1 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| `store/daily-report-card` | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 1（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） | 0（+0%） |

## judge 明细（规则 judge 进门禁，模型 judge 只报不拦）

### `ops/cross-desk-handover` —— 5/5

- ✓ `required_fields` @ apr_01M1WP24M000HWMXAT1JG：subject=22 body=456 signature=true
- ✓ `tone` @ apr_01M1WP24M000HWMXAT1JG：没有禁用词
- ✓ `no_overreach` @ apr_01M1WP24M000HWMXAT1JG：claims=[] promises=[] applied=false
- ✓ `cites_facts` @ apr_01M1WP24M000HWMXAT1JG：citations=1
- ✓ `require_any` @ apr_01M1WP24M000HWMXAT1JG：命中 order

### `ops/multi-desk-concurrency` —— 15/15

- ✓ `required_fields` @ apr_01M1WP24M000HWMXAT1JG：subject=22 body=456 signature=true
- ✓ `tone` @ apr_01M1WP24M000HWMXAT1JG：没有禁用词
- ✓ `no_overreach` @ apr_01M1WP24M000HWMXAT1JG：claims=[] promises=[] applied=true
- ✓ `cites_facts` @ apr_01M1WP24M000HWMXAT1JG：citations=1
- ✓ `require_any` @ apr_01M1WP24M000HWMXAT1JG：命中 order
- ✓ `required_fields` @ apr_01M1WPR3R0TG4R0VK756S：subject=19 body=427 signature=true
- ✓ `tone` @ apr_01M1WPR3R0TG4R0VK756S：没有禁用词
- ✓ `no_overreach` @ apr_01M1WPR3R0TG4R0VK756S：claims=[] promises=[] applied=true
- ✓ `cites_facts` @ apr_01M1WPR3R0TG4R0VK756S：citations=1
- ✓ `require_any` @ apr_01M1WPR3R0TG4R0VK756S：命中 order
- ✓ `required_fields` @ apr_01M1WQFXF07KYVQREA3DD：subject=21 body=456 signature=true
- ✓ `tone` @ apr_01M1WQFXF07KYVQREA3DD：没有禁用词
- ✓ `no_overreach` @ apr_01M1WQFXF07KYVQREA3DD：claims=[] promises=[] applied=true
- ✓ `cites_facts` @ apr_01M1WQFXF07KYVQREA3DD：citations=1
- ✓ `require_any` @ apr_01M1WQFXF07KYVQREA3DD：命中 order

### `ops/two-desks-no-union` —— 5/5

- ✓ `required_fields` @ apr_01M1WP24M000HWMXAT1JG：subject=22 body=456 signature=true
- ✓ `tone` @ apr_01M1WP24M000HWMXAT1JG：没有禁用词
- ✓ `no_overreach` @ apr_01M1WP24M000HWMXAT1JG：claims=[] promises=[] applied=true
- ✓ `cites_facts` @ apr_01M1WP24M000HWMXAT1JG：citations=1
- ✓ `require_any` @ apr_01M1WP24M000HWMXAT1JG：命中 order

