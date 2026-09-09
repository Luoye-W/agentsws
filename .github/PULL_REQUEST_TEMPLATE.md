<!--
中文或英文都可以 / Chinese or English, both fine.
一个 PR 一件事。删掉用不上的段落。
-->

## What this changes

<!-- One paragraph. What was wrong or missing, and what this does about it. -->

## Why

<!-- Link the issue if there is one: Closes #123 -->

## How it was verified

<!--
The consistency suite and the simulation loop are the real evidence here, not a
description of the change. Paste the numbers.

  pnpm install --frozen-lockfile
  pnpm exec tsc -b --force
  pnpm exec biome check .
  pnpm exec vitest run
  pnpm -s simulate --tier fast --pack packs/dtc-3c-3p --scenario 'scenarios/**/*.yml' --seed 42
-->

```
tsc      :
biome    :
vitest   :  N passed
simulate :  N/8 scenarios, merge gate:
```

## Checklist

Review checklist from `docs/35` §2 (shared constraints) and §3 (merge review).

**Green before review**

- [ ] `tsc -b --force`, `biome check .`, `vitest run` all pass
- [ ] `pnpm -s simulate --tier fast --pack packs/dtc-3c-3p` still passes 8/8 and the merge
      gate reports pass (metrics not regressed)
- [ ] New behaviour has tests next to it in `test/`; public functions are covered
- [ ] CI is green on both `ubuntu-latest` and `macos-latest`

**Scope**

- [ ] One thing per PR; changes stay inside the package(s) this PR is about
- [ ] No new dependency, or a new dependency is called out below with a reason
- [ ] Contracts (`packages/contracts`) unchanged — or, if changed, only **added** fields,
      kinds, events or error codes (interfaces are frozen, `docs/32` §2; changing the
      meaning of an existing contract needs a major version and a migrator, and should be
      discussed in an issue first)
- [ ] Docs updated if behaviour changed. Chinese design docs stay Chinese;
      `docs/ARCHITECTURE.md`, `README` top section and the GitHub templates stay English

**House rules** (`docs/35` §2)

- [ ] TypeScript strict, ESM, `import type`, no `any`
- [ ] Time comes from an injected `Clock`; randomness from an injected seed —
      no bare `Date.now()` / `Math.random()`
- [ ] All SQL is parameterised; no package reads another package's tables
- [ ] Secrets only from environment variables or the local secret store; test values are fake
- [ ] No credentials, real customer data or real customer email in code, tests, fixtures
      or this PR description

**Safety-critical paths** — tick only the ones this PR touches

- [ ] Every write still goes stage → approve → apply; nothing writes without a staged change
- [ ] Approval decisions stay bound to the execution snapshot; a changed revision
      invalidates the old `decision_token`
- [ ] External text (email bodies, order notes, page content, transcripts) is fenced before
      it reaches a model
- [ ] Model-visible ⟺ logged: everything that entered a prompt can be rebuilt from the
      event log (`prompt_replayable` invariant)
- [ ] Authorization is the full (domain, ops, range, sensitivity) tuple; no dimension-wise union
- [ ] Credentials never pass through a model and never appear in responses, events or logs

## DCO

Contributions are under the [DCO](https://developercertificate.org/), not a CLA.
Every commit needs a sign-off line:

```
Signed-off-by: Your Name <you@example.com>
```

- [ ] Every commit in this PR is signed off (`git commit -s`)

<!--
Forgot? Fix the last commit with `git commit --amend -s`, or the whole branch with
`git rebase --signoff origin/main`, then force-push. The DCO workflow checks this.
-->
