<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/mark-idle-dark.svg">
    <img src="docs/assets/brand/mark-idle-light.svg" alt="Agents Workshop" width="99" height="99">
  </picture>
</p>

<h1 align="center">Agents Workshop</h1>

<p align="center"><b>Dashboards gather dust. This AI team shows up every day.</b></p>

<p align="center">
  AI agents built for cross-border e-commerce sellers.<br>
  Support, creators, Reddit, ads, site building, B2B: a full set of roles that only come to you when it’s your call.
</p>

<p align="center">
  <a href="https://agentsws.com/en/"><b>Website</b></a> ·
  <a href="https://agentsws.com/en/download/"><b>Download free</b></a> ·
  <a href="https://agentsws.com/en/pricing/">Pricing</a> ·
  <a href="https://agentsws.com/en/docs/">Guides</a> ·
  <a href="https://agentsws.com/en/changelog/">Changelog</a> ·
  <a href="README.md">中文</a>
</p>

<p align="center">
  <a href="https://github.com/Luoye-W/agentsws/actions/workflows/ci.yml"><img src="https://github.com/Luoye-W/agentsws/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/site/src/assets/app/home-dark.png">
    <img src="apps/site/src/assets/app/home-light.png" alt="The Workshop: roles on the left, each role’s cards waiting for your call in the middle" width="860">
  </picture>
</p>

Open source · Apache-2.0 · Runs on your own computer. Double-click to install on Mac or Windows; currently in beta. (The screenshots show the Chinese interface; the app also runs in English.)

---

## Hire by role

Short on people? Add a role. Each one owns its lane and keeps its own memory; anything that needs your call becomes a card first.

| Role | What it does | Cards it hands you |
|---|---|---|
| Customer Care | Email, site chat, Amazon messages — drafted for you to send | Replies · Refunds / reships · Address changes |
| Creator Marketing | Find and score creators, pitch, follow through | Pitches · Quotes and terms · Content review |
| Social Media | Plan posts, reply; checks your Reddit inbox and subreddits daily | Posts · Comment replies · Reddit replies (you hit send) |
| Web Operations | Products, promos, email — and how AI answers about your category | Price / promo changes · Email campaigns · Fulfilment |
| Paid Ads | Google and Meta: watch spend, write new copy, preview every change | Stop-loss pauses · New headlines and descriptions · Upload sheets (preview first) |
| Site Building | Builds pages and switches themes on Shopify — shows you first | Theme choice · Page edits · Launch checklist |
| B2B | Grade inquiries, quote within your limits, follow orders through | First replies · Quotes (PDF) · Sample notices · Rep handovers |
| Public Relations | Press releases, forum presence, mentions and early warnings | Press pitches · Forum replies · Negative-mention alerts |
| Design | On-brand images for your site, Amazon, social and ads | Images · Ad creative in batches |

Need something else? Create your own role on the Company page, and rename any role to match how your company talks. → [What each role does](https://agentsws.com/en/roles/)

## Tell it in a few sentences. It sets itself up.

No admin panels to learn, no workflows to draw. If something’s missing, it asks you in the chat.

- **Connect your platforms in one click** — Shopify, Amazon, Google / Meta Ads, Reddit…: through the accounts you’re already signed in to in your browser (with the browser extension), or one click to authorize. No developer apps to apply for, no terminal.
- **Fills gaps on the spot** — Missing a connection or a setting? A card pops up in the chat; fill it in and the work carries on.
- **Answers come as charts** — Ask about your numbers and get charts, tables and stat cards back.
- **Say it, and it’s set up** — A weekly report, logging to your own spreadsheet: just tell it. No waiting for us to ship a feature.
- **Shows up on schedule** — Daily checks and weekly reports, right on time.
- **Everything on record** — Every message sent is logged on your computer, along with who approved it.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/site/src/assets/app/answer-dark.png">
    <img src="apps/site/src/assets/app/answer-light.png" alt="A role page: ask how the store did this week and get stat cards, a bar chart and a table back" width="860">
  </picture>
</p>

## AI proposes. You decide. Always.

Anything that goes out, costs money or changes something becomes a card first, with reasons and sources. You pick: send, edit, or drop.

Refunds, reships, price changes and publishing are always human-approved. No approval rate unlocks autopilot.

## Your business stays on your computer

- **Double-click to install** — Mac and Windows. No Docker, no command line.
- **Your keys stay yours** — Store and mailbox passwords go into a native form and an encrypted vault on this computer. Never seen by the AI, never logged.
- **Cloud is opt-in** — Data only goes to the cloud when you turn on a cloud service or run a long task there: just the part that’s needed, exportable and deletable.
- **Model down? Everything stops** — No half-baked sends when the AI can’t be reached.

## For one person, a team, or the whole company

- **Solo (default)** — Just you, several brands; every role is yours. Nothing goes out until you approve it.
- **Team** — Colleagues side by side: everyone runs their own roles and nobody signs off on anybody. Hand work to a colleague; it’s theirs once they accept.
- **Whole company** — The owner turns it on: one balance, a monthly cap and store access for each member, and what matters goes up the chain for approval.

Start on your own and move up when you need to. Your data comes along; nothing to reinstall.

## Pricing

The open-source edition is free and complete. Bring your own model key: it connects directly, never through us, and costs nothing. If you’d rather not sign up anywhere or paste keys, use Workshop credits: pay as you go, no seats, no subscription. → [Pricing](https://agentsws.com/en/pricing/)

## Built on DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the base; Agents Workshop is a distribution of it, extended the official way with its core left alone. Every upstream release is evaluated, and we upgrade only when the tests and the simulation loop pass.

---

## For developers

### Run from source

You need Node ≥ 22 and pnpm ≥ 10 (`corepack enable pnpm`). None of the steps below need a model key or any account.

```bash
git clone https://github.com/Luoye-W/agentsws.git
cd agentsws
pnpm install
pnpm build

# The workstation, backed by a simulated company; listens on 127.0.0.1 only (add --port 4318 if the port is taken)
pnpm dev:demo

# The simulation loop: the simulated company runs every scenario, and all six invariants must pass (this is the CI merge gate)
pnpm simulate --tier fast --pack packs/dtc-3c-3p --scenario 'scenarios/**/*.yml' --seed 42

pnpm test
pnpm lint
```

Just want to use it? Grab the desktop app from the [download page](https://agentsws.com/en/download/) instead.

### Repository layout

| Directory | What’s in it |
|---|---|
| `apps/` | Desktop shell, workstation, server, CLI, browser extension, website… |
| `packages/` | Contracts and their implementations: approvals, data, roles, knowledge, model gateway, each role’s domain package… |
| `role-packs/` · `skills/` | Duty packs and shared skills |
| `packs/` | Simulated-company datasets for the simulation loop |
| `docs/help/` | Source of the user guides; the website’s Guides section reads them directly |

Layers, contracts, approvals and the security model: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Sign off your commits with DCO (`git commit -s`); no CLA. Code of conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Please **don’t open public issues for security problems**; use the private channel in [`SECURITY.md`](SECURITY.md).

### License

Code is released under **Apache-2.0** ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)). The name and logo are not covered by that license; see [`TRADEMARK.md`](TRADEMARK.md): forks are welcome, under a different name.
