# Security Policy

*中文读者：本文件用英文写，是给外部安全研究者看的。报告漏洞可以用中文，我们看得懂。*

## This is not production-ready software

agentsws is at `0.1.0-alpha`. Read this before you point it at a real company.

- It runs an agent that reads your customer email and your store data, and proposes
  writes (refunds, replies, reships). Every write goes through a human approval queue —
  that gate is the core of the design and it is tested (see `docs/ARCHITECTURE.md`,
  "Approvals and the ledger"). But the surrounding system has not been through a
  third-party audit, a real production deployment, or a bug bounty.
- Whole layers are absent or half-built. `docs/38-底层收口清单.md` §1 is an honest,
  per-contract inventory of what works, what half-works, and what does not exist.
  The README carries the same table in short form. Nothing in this repository is
  described as finished when it is not.
- The threat model assumes **everything below the external boundary is hostile input**:
  customer email, order notes, web pages, connector responses, meeting transcripts.
  Prompt injection is treated as a certainty, not a risk. There are simulation scenarios
  that attack the system this way (`packs/dtc-3c-3p/scenarios/security/`) and they run on
  every commit. That does not mean every injection is caught.
- Credentials live in your machine, not ours: an AES-256-GCM local secret store plus the
  OpenConnector credential vault. Keys are read from environment variables. There is
  **no key rotation** yet. If a key leaks, you must re-issue every credential by hand.
- Single-tenant, loopback-only by design: the API server binds `127.0.0.1`. Do not expose
  it to a network. There is no hardened multi-tenant mode, no rate-limited public surface,
  and no TLS termination of our own.

If any of that is unacceptable for your situation, wait for a later release.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's private vulnerability reporting:
<https://github.com/Luoye-W/agentsws/security/advisories/new>

If you cannot use that, open a public issue that says only "security report, please
contact me" with no details, and a maintainer will reach out to arrange a private channel.

Please include:

- what you attacked (component, version or commit, tier — simulation or real accounts)
- steps to reproduce, ideally as a simulation scenario YAML under `packs/*/scenarios/`
- what an attacker gets: data read, a write applied without approval, a credential
  disclosed, a gate bypassed
- your assessment of severity, and whether the issue is already public anywhere

We aim to acknowledge within 5 working days and to give you a fix or a plan within
30 days. We will credit you in the release notes unless you ask us not to. There is no
bug bounty; this project has no revenue.

## What we consider a vulnerability

High interest, in rough priority order:

1. **A write that reaches the outside world without an approved, snapshot-bound decision.**
   Any path from model output to an applied change that skips `ChangeLedger.stage` →
   approval → `Executor.apply`.
2. **Approval-snapshot bypass.** Making an approved item apply against a payload,
   recipient, target or mandate other than the one the human saw.
3. **Prompt injection that changes what gets staged or sent**, including recipient
   injection (mail going to an address the model invented rather than a thread participant).
4. **Authorization bypass in the data layer.** Reading a record outside the acting
   assignment's (domain, ops, range, sensitivity) tuple, or bypassing the Casbin gate.
5. **Credential disclosure.** A secret appearing in an API response, the event log, a
   report, the workstation DOM, `localStorage`, a log line, or any file under the data
   directory.
6. **Event-log tampering.** Breaking append-only enforcement or the hash chain.
7. **Sandbox escape from a role pack, skill, or scenario file** into code execution.

## Out of scope

- The `packs/`, `presets/` and `skills/` content shipped as examples is synthetic data,
  not a security boundary.
- Denial of service against your own loopback server.
- Anything that requires the attacker to already have the workspace owner's session or
  the machine's encryption keys.
- Vulnerabilities in upstream projects (DeepSeek Harness, OpenConnector, Cordis,
  better-sqlite3, Electron). Report those upstream; tell us too, and we will pin or patch.
- Missing hardening we already document as missing in `docs/38-底层收口清单.md` §1 —
  tell us anyway if you can show real impact, but expect "known, tracked" as the answer.

## Supported versions

Only the latest commit on `main` and the newest tag. There are no maintenance branches
and no backports before `1.0.0`.

| Version | Supported |
|---|---|
| `main` | yes |
| latest `0.1.x-alpha` tag | yes |
| anything older | no |

## Operator checklist

If you run agentsws against real accounts:

- Keep it on `127.0.0.1`. Use the desktop shell or an SSH tunnel, not a reverse proxy.
- Run OpenConnector with `OOMOL_CONNECT_ENCRYPTION_KEY`, `OOMOL_CONNECT_ADMIN_TOKEN`
  and `OOMOL_CONNECT_BLOCKED_PROXIES=*` set — `scripts/dev-real.sh` does this for you and
  refuses to start otherwise.
- Use scoped credentials: a Shopify custom app with the minimum scopes, an app-specific
  mail password, never your personal password.
- Keep the machine's disk encrypted. The SQLite files and the secret store are only as
  private as the filesystem under them.
- Read every approval card before you approve it. That is the whole product.
