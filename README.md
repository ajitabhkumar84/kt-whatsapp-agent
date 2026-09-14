# `kt-whatsapp-agent` — runner scaffold

These files do **not** belong in this repository. They are the complete contents of the
**public** `kt-whatsapp-agent` repo (manual step **M2**), kept here only so they are version
controlled alongside the endpoint they call.

## Why a separate, public repo

Cloudflare **Pages has no cron support** — no `[triggers]`, no `scheduled()` handler — so
something outside Cloudflare has to drive the 15-minute sweep. GitHub Actions gives *public*
repositories unlimited minutes; a private repo gets 2,000/month, and a 15-minute schedule is
roughly 2,880 runs. Hence public.

In Phase 3 the model runs **inside** this same workflow. Nothing here is throwaway.

## Security rules (non-negotiable — PLAN.md §3)

- Triggers are **`schedule` and `workflow_dispatch` only**. Never `pull_request_target`,
  never `workflow_run`. Both can be made to run attacker-controlled code with secrets in scope.
- This repo holds **no pricing, no customer data, no Meta credentials**. It knows the site URL
  and one shared secret. Everything else lives behind the HMAC-signed `/api/agent/*` contract.
- **Run logs are world-readable.** The sweep endpoint returns only counters — never message
  bodies, never phone numbers, never `leadId` (which embeds the phone number). Do not add
  logging that prints the response body verbatim if that ever changes.
- The Meta DevTools MCP must **never** be wired in here. It carries the owner's developer
  credentials and can mutate app configuration.

## Install

```
kt-whatsapp-agent/
├── .github/workflows/sweep.yml
└── scripts/sweep.mjs
```

Then add three repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `AGENT_HMAC_SECRET` | The same 64-char hex secret set on Cloudflare (**M18**) |
| `SITE_BASE_URL` | `https://kathgodamtaxi.in` |

Verify with **Actions → Sweep → Run workflow**. A healthy run prints a counters line and
exits 0. With the agent switched off in Sanity it prints `agentEnabled: false` and does
nothing — which is the correct result, not a failure.

## Two GitHub Actions facts to plan around

1. **Scheduled runs are often 5–15 minutes late** under platform load, and are occasionally
   skipped entirely. Harmless here: the delay window is 30 minutes and the sweep is
   idempotent. Do not tighten the schedule to compensate — it makes drops more likely, not
   less.
2. **GitHub disables schedules in a repo with 60 days of no commits.** If the agent ever goes
   quiet for weeks, check this first. The `keepalive` job below touches the repo monthly so
   it cannot happen silently.
