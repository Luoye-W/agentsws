/**
 * 后台那几张表（65 §2 / §5 / §7）。
 *
 * 为什么 SQL 写在这里而不是 `store.ts` 里：`store.ts` 的 `MIGRATIONS` 数组只多了
 * 一行 `{ version: 2, sql: ADMIN_MIGRATION_V2 }`，其余一个字没动。新东西写进新文件，
 * 合并时不用逐行看冲突。
 *
 * 六条设计决定，每条都有一句为什么：
 *
 * 1. **角色是 `cloud_accounts` 上的一列，不是一张表**。一个人一个角色，没有
 *    "在这个组织里是 support、在那个组织里是 user"这回事——后台是我们自己的，
 *    不是商家的。旧行这一列是 NULL，读出来当 `user`。
 * 2. **后台会话与 `cloud_sessions` 分开**。那一张是本地关联向导用的 Bearer token，
 *    会被本机服务进程存进加密库；这一张是 httpOnly cookie。混在一张表里意味着
 *    "吊销某人的后台会话"会顺手把他电脑上的关联也断掉。
 * 3. **封禁是一张有历史的表**，不是账号上的一个布尔：解封之后"他什么时候被封过、
 *    为什么"必须还查得到。
 * 4. **黑名单只存哈希**（邮箱本身 + 规范化别名各一列）。它是一张"我们讨厌过谁"的
 *    清单，没有理由以明文躺在库里（21 §1）。
 * 5. **审计表只增不改**：没有 UPDATE，没有 DELETE，主键自增。
 * 6. **会员拆成 term + cycle 两张表**（KefuAgent 的模型）。`grant_key` 上有唯一索引：
 *    就算逻辑上漏判一次，库也会把第二笔挡回来。
 */

export const ADMIN_MIGRATION_V2 = `
-- ① 角色：只加一列。NULL = 'user'（旧行全是这一档）
ALTER TABLE cloud_accounts ADD COLUMN role TEXT;
-- 删号之后账号行**不删**，写一个墓碑时间：审计里那条 account.delete 还指着这个 id
ALTER TABLE cloud_accounts ADD COLUMN deleted_at TEXT;

-- ② 组织停用：停用 = 云端服务入口拒绝，**不影响他本地的软件**（65 §4）
ALTER TABLE cloud_orgs ADD COLUMN suspended_at TEXT;
ALTER TABLE cloud_orgs ADD COLUMN suspended_reason TEXT;

-- ③ 后台的网页会话（httpOnly cookie；滑动 12 小时，绝对 7 天）
CREATE TABLE IF NOT EXISTS admin_sessions (
  id                  TEXT PRIMARY KEY NOT NULL,
  token_sha256        TEXT NOT NULL UNIQUE,
  -- CSRF 双提交的那一枚也只存哈希：库被读走也换不来一次有效的写请求
  csrf_sha256         TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  revoked_at          TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS admin_sessions_account ON admin_sessions (account_id);

-- ④ 封禁（有历史；解封写 lifted_at，不删行）
CREATE TABLE IF NOT EXISTS account_bans (
  id         TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  reason     TEXT NOT NULL,
  banned_by  TEXT NOT NULL,
  banned_at  TEXT NOT NULL,
  expires_at TEXT,
  lifted_at  TEXT,
  lifted_by  TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS account_bans_account ON account_bans (account_id, banned_at);

-- ⑤ 邮箱黑名单（删号之后）。两列哈希：字面量一列、规范化别名一列
CREATE TABLE IF NOT EXISTS banned_emails (
  email_sha256 TEXT PRIMARY KEY NOT NULL,
  alias_sha256 TEXT NOT NULL,
  reason       TEXT NOT NULL,
  banned_by    TEXT NOT NULL,
  banned_at    TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS banned_emails_alias ON banned_emails (alias_sha256);

-- ⑥ 审计：**只增不改**。details 是一小段 JSON，里面没有令牌、没有完整邮箱、没有正文
CREATE TABLE IF NOT EXISTS admin_audit (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               TEXT NOT NULL,
  action           TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  actor_role       TEXT NOT NULL,
  target_kind      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  details          TEXT NOT NULL,
  ip               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_audit_at     ON admin_audit (at);
CREATE INDEX IF NOT EXISTS admin_audit_target ON admin_audit (target_id, at);

-- ⑦ 会员：一段 term
CREATE TABLE IF NOT EXISTS membership_terms (
  id           TEXT PRIMARY KEY NOT NULL,
  org_id       TEXT NOT NULL,
  plan_id      TEXT NOT NULL,
  anchor_at    TEXT NOT NULL,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  note         TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS membership_terms_org ON membership_terms (org_id, starts_at);

-- ⑧ term 里的一个月。grant_key 唯一——定时任务重跑一百次也只发一次
CREATE TABLE IF NOT EXISTS membership_cycles (
  id         TEXT PRIMARY KEY NOT NULL,
  term_id    TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  grant_key  TEXT NOT NULL UNIQUE,
  credits    REAL NOT NULL,
  granted_at TEXT,
  lot_id     TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS membership_cycles_term ON membership_cycles (term_id, idx);
CREATE INDEX IF NOT EXISTS membership_cycles_due  ON membership_cycles (granted_at, starts_at);
`

/**
 * 注册赠送的领取记录（70 §2，WP121）。
 *
 * 为什么不能只靠钱包那边的 `source_ref` 幂等：`source_ref` 是
 * `signup_bonus:<account_id>`，而 `a.b+x@gmail.com` 与 `ab@gmail.com` 是**两个
 * 账号**——两个 account_id，两串 source_ref，于是同一个人能领两份。所以这里按
 * **规范化别名**再挡一道（`normalizeEmailAlias`，WP115 那个函数）。
 *
 * 三条：
 *
 * 1. **主键是别名哈希**，不是账号 id：一个人换一百个 `+tag` 也只有一行；
 * 2. **只存哈希**，与黑名单同一条纪律（21 §1）——这张表没有理由存明文邮箱；
 * 3. `lot_id` 留着，好在后台把这一行与发放流水里那一笔对上。
 */
export const ADMIN_MIGRATION_V3 = `
CREATE TABLE IF NOT EXISTS signup_bonuses (
  alias_sha256 TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  org_id       TEXT NOT NULL,
  credits      REAL NOT NULL,
  granted_at   TEXT NOT NULL,
  lot_id       TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS signup_bonuses_account ON signup_bonuses (account_id);
`
