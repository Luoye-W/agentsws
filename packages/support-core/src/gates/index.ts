/**
 * 15 guardrail 前置的三道「不自主」门（48 §4 L3 #3）：
 * `l3_denylist` / `draft_origin` / `commitment_scan`。
 *
 * 词表与正则**逐字节抄 KefuAgent**（`policy/l3-denylist.ts` + `verticals/goods/l3.ts`
 * + `knowledge-learning.ts` 的 `POLICY_COMMITMENT_RE`）；规则集有内容哈希
 * `GATE_RULESET_HASH`，契约是只可加行。
 */
export * from './gates.js'
export * from './l3-denylist.js'
