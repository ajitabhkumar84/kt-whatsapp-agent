// Trigger the two-call sweep on the private site.
//
// Call 1 fetches queued translation jobs (Substage 3.1); each is rewritten by
// Haiku here; Call 2 posts the rewrites back for server-side validation,
// finalizing and sending. This runner holds no business logic: it signs
// requests and reports counters. Every decision about who to message, what to
// say and whether to say it at all is made behind the HMAC boundary, on the
// private side, where the pricing and the customer data live.

import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { runTranslationJob } from './lib/translation-job.mjs';
import { runFaqJob } from './lib/faq-job.mjs';

// Must be in ACCEPTED_CONTRACT_VERSIONS in src/lib/agent-auth.ts on the
// private side (currently ['2.2', '2.1'] during the Substage 3.2 burn-in). A
// mismatch is rejected with 409 rather than best-effort parsed, because the
// two repositories deploy independently and a silent drift would surface as
// strange behaviour on live customer conversations.
const CONTRACT_VERSION = '2.2';

const secret = process.env.AGENT_HMAC_SECRET;
const baseUrl = process.env.SITE_BASE_URL;

if (!secret || !baseUrl) {
  console.error('Missing AGENT_HMAC_SECRET or SITE_BASE_URL. Check repository secrets.');
  process.exit(1);
}

async function postSweep(payload) {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  // The timestamp is inside the signed payload, so a captured request cannot
  // have its life extended by editing the header.
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const url = new URL('/api/agent/sweep', baseUrl).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-signature': signature,
        'x-agent-timestamp': timestamp,
        'x-agent-contract-version': CONTRACT_VERSION,
      },
      body,
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

function failHttp(status) {
  // Status and nothing else. The body could carry detail we should not print
  // into a world-readable public log.
  console.error(`Sweep failed: HTTP ${status}`);
  if (status === 409) {
    console.error('Contract version mismatch — update CONTRACT_VERSION in this repo to match the site.');
  }
  if (status === 401) {
    console.error('Signature rejected — AGENT_HMAC_SECRET here does not match the one on Cloudflare.');
  }
  process.exit(1);
}

try {
  // --- Call 1 -------------------------------------------------------------
  const call1 = await postSweep({});
  if (!call1.ok) failHttp(call1.status);

  let result1;
  try {
    result1 = JSON.parse(call1.text);
  } catch {
    console.error('Sweep returned a non-JSON response.');
    process.exit(1);
  }

  if (result1.agentEnabled === false) {
    console.log('Agent is switched off in Sanity. Nothing to do.');
    process.exit(0);
  }

  // Counters only. The endpoint deliberately returns no message bodies, no
  // phone numbers and no lead ids (a leadId embeds the customer's number).
  const mode = result1.allowlistOnly ? 'allowlist-only' : result1.shadowMode ? 'shadow' : 'live';
  console.log(
    `Sweep ok [call 1, ${mode}] — considered=${result1.considered} sent=${result1.sent} ` +
      `drafted=${result1.drafted} skipped=${result1.skipped} blocked=${result1.blocked} failed=${result1.failed} ` +
      `queuedForTranslation=${result1.queuedForTranslation ?? 0} queuedForFaq=${result1.queuedForFaq ?? 0}`
  );
  if (result1.blocked > 0) console.log(`::warning::${result1.blocked} message(s) were blocked before sending.`);
  if (result1.failed > 0) console.log(`::warning::${result1.failed} message(s) failed to send.`);

  const jobs = result1.translationJobs || [];
  if (jobs.length === 0) {
    console.log('No translation jobs this tick.');
    process.exit(0);
  }

  // --- Per-job Haiku call ----------------------------------------------------
  // Partitioned by kind (Substage 3.2): the four ask-kinds still go through
  // translation-job.mjs's pure re-expression prompt; faq_answer goes through
  // faq-job.mjs's own content-selection prompt instead. Merged into one
  // composedReplies[] afterwards — Call 2 tells them apart by jobId lookup,
  // not by anything in this array's shape.
  const composedReplies = [];
  for (const job of jobs) {
    if (job.kind === 'faq_answer') {
      composedReplies.push(await runFaqJob(job, { spawnFn: spawn }));
    } else {
      composedReplies.push(await runTranslationJob(job, { spawnFn: spawn }));
    }
  }

  // --- Call 2 ---------------------------------------------------------------
  const call2 = await postSweep({ composedReplies });
  if (!call2.ok) failHttp(call2.status);

  let result2;
  try {
    result2 = JSON.parse(call2.text);
  } catch {
    console.error('Call 2 returned a non-JSON response.');
    process.exit(1);
  }

  console.log(
    `Sweep ok [call 2] — drafted=${result2.drafted} sent=${result2.sent} blocked=${result2.blocked} ` +
      `failed=${result2.failed} translationSuccessCount=${result2.translationSuccessCount} ` +
      `translationFallbackCount=${result2.translationFallbackCount} ` +
      `faqAnswerSuccessCount=${result2.faqAnswerSuccessCount ?? 0} faqAnswerNoMatchCount=${result2.faqAnswerNoMatchCount ?? 0} ` +
      `faqAnswerFallbackCount=${result2.faqAnswerFallbackCount ?? 0}`
  );
  // Content-free counters (no template text, no jobIds, no phone numbers) —
  // safe for this world-readable log. Printed whenever any fallback happened,
  // since Cloudflare only tails console.warn live and cannot show why a past
  // run's validation rejected a rewrite; this is the durable substitute.
  if (result2.translationFallbackCount > 0 && result2.translationFallbackReasons) {
    console.log(`Translation fallback reasons: ${JSON.stringify(result2.translationFallbackReasons)}`);
  }
  // Bare expected/actual counts only — pins down a drop/merge/add without the
  // rewrite text itself.
  if (result2.translationAskItemMismatches?.length > 0) {
    console.log(`Ask-item count mismatches: ${JSON.stringify(result2.translationAskItemMismatches)}`);
  }
  // Same content-free convention as the translation counters above —
  // faqAnswerNoMatchCount is NOT a failure (the runner's own "none of the
  // shortlist confidently fits" outcome), so it is not included here; only
  // faqAnswerFallbackReasons ever needs a breakdown.
  if (result2.faqAnswerFallbackCount > 0 && result2.faqAnswerFallbackReasons) {
    console.log(`FAQ answer fallback reasons: ${JSON.stringify(result2.faqAnswerFallbackReasons)}`);
  }
  if (result2.blocked > 0) {
    console.log(`::warning::${result2.blocked} translated message(s) were blocked before sending.`);
  }
  if (result2.failed > 0) {
    console.log(`::warning::${result2.failed} translated message(s) failed to send.`);
  }

  process.exit(0);
} catch (error) {
  console.error(`Sweep request failed: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
  process.exit(1);
}
