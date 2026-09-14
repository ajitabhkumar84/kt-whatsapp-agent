# `kt-whatsapp-agent` — runner scaffold

These files do **not** belong in this repository. They are the complete contents of the
**public** `kt-whatsapp-agent` repo (manual step **M2**), kept here only so they are version
controlled alongside the endpoint they call.

## Why a separate, public repo

Cloudflare **Pages has no cron support** — no `[triggers]`, no `scheduled()` handler — so
something outside Cloudflare has to drive the 15-minute sweep. GitHub Actions gives *public*
repositories unlimited minutes; a private repo gets 2,000/month, and a 15-minute schedule is
roughly 2,880 runs. Hence public.

As of Substage 3.1, the model runs **inside** this same workflow. Nothing here is throwaway.

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
├── scripts/sweep.mjs
├── scripts/sweep.translation.test.mjs   (manual/opt-in — see below)
└── scripts/lib/translation-job.mjs
```

Then add the three repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `AGENT_HMAC_SECRET` | The same 64-char hex secret set on Cloudflare (**M18**) |
| `SITE_BASE_URL` | `https://kathgodamtaxi.in` |
| `CLAUDE_CODE_OAUTH_TOKEN` | 1-year OAuth token from `claude setup-token` (**M11**), with usage-credit overage disabled (**M12**) — never a pay-as-you-go API key |

Verify with **Actions → Sweep → Run workflow**. A healthy run prints a counters line and
exits 0. With the agent switched off in Sanity it prints `agentEnabled: false` and does
nothing — which is the correct result, not a failure.

## Two-call flow (Substage 3.1)

`sweep.mjs` now makes **two** sequential requests to `POST /api/agent/sweep` in one workflow run,
because `claude -p` can only run here in GitHub Actions, not in the Cloudflare Worker:

1. **Call 1** — an empty-body POST, exactly like Phase 2. The response may include
   `translationJobs[]`: ask-kind replies the private site wants re-expressed in the customer's
   language register, each carrying only a `jobId`, `kind`, `languageHint`, `templateText` and
   `askItemCount` — never a phone number, lead id, or transcript content.
2. **Per-job rewrite** — `scripts/lib/translation-job.mjs`'s `runTranslationJob` spawns
   `claude -p '<prompt>' --append-system-prompt '<system prompt>' --model haiku --output-format json
   --json-schema '<schema>'` for each job, sequentially. **Never pass `--bare`** — bare mode requires
   `ANTHROPIC_API_KEY`/`apiKeyHelper` and explicitly does not use subscription login; using it would
   silently switch this onto a metered API key, which is the one thing this whole substage exists to
   avoid. A job that fails to parse or times out resolves `{ jobId, failed: true }` and never aborts
   the batch — the private site falls back to the English template for that job alone.
3. **Call 2** — a POST carrying `composedReplies: [{ jobId, text, failed }, ...]`. The private site
   re-validates every rewrite (Devanagari check, price guard, ask-item count, length bounds) before
   finalizing and sending — this runner's output is never trusted blindly.

If a future edit is tempted to "optimize startup" by adding `--bare` or reaching for
`ANTHROPIC_API_KEY`, don't — re-read point 2 above first.

## Two GitHub Actions facts to plan around

1. **Scheduled runs are often 5–15 minutes late** under platform load, and are occasionally
   skipped entirely. Harmless here: the delay window is 30 minutes and the sweep is
   idempotent. Do not tighten the schedule to compensate — it makes drops more likely, not
   less.
2. **GitHub disables schedules in a repo with 60 days of no commits.** If the agent ever goes
   quiet for weeks, check this first. (Pre-existing doc note, not yet fixed: this file has
   referred to "the `keepalive` job below" since before Substage 3.1, but no such job exists in
   `sweep.yml` — either add one or drop the sentence next time this file is touched.)
