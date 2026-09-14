// Trigger one sweep on the private site.
//
// This is the entire Phase 2 runner. It holds no business logic: it signs a
// request and reports counters. Every decision about who to message, what to
// say and whether to say it at all is made behind the HMAC boundary, on the
// private side, where the pricing and the customer data live.
//
// In Phase 3 the model runs in this same workflow, between fetching a queue and
// posting replies back. Nothing here is throwaway.

import { createHmac } from 'node:crypto';

// Must match AGENT_CONTRACT_VERSION in src/lib/agent-auth.ts on the private
// side. A mismatch is rejected with 409 rather than best-effort parsed, because
// the two repositories deploy independently and a silent drift would surface as
// strange behaviour on live customer conversations.
const CONTRACT_VERSION = '2.0';

const secret = process.env.AGENT_HMAC_SECRET;
const baseUrl = process.env.SITE_BASE_URL;

if (!secret || !baseUrl) {
  console.error('Missing AGENT_HMAC_SECRET or SITE_BASE_URL. Check repository secrets.');
  process.exit(1);
}

const body = JSON.stringify({});
const timestamp = Date.now().toString();
// The timestamp is inside the signed payload, so a captured request cannot have
// its life extended by editing the header.
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

  const text = await response.text();

  if (!response.ok) {
    // Status and nothing else. The body could carry detail we should not print
    // into a world-readable public log.
    console.error(`Sweep failed: HTTP ${response.status}`);
    if (response.status === 409) {
      console.error('Contract version mismatch — update CONTRACT_VERSION in this repo to match the site.');
    }
    if (response.status === 401) {
      console.error('Signature rejected — AGENT_HMAC_SECRET here does not match the one on Cloudflare.');
    }
    process.exit(1);
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    console.error('Sweep returned a non-JSON response.');
    process.exit(1);
  }

  if (result.agentEnabled === false) {
    console.log('Agent is switched off in Sanity. Nothing to do.');
    process.exit(0);
  }

  // Counters only. The endpoint deliberately returns no message bodies, no
  // phone numbers and no lead ids (a leadId embeds the customer's number).
  const mode = result.allowlistOnly ? 'allowlist-only' : result.shadowMode ? 'shadow' : 'live';
  console.log(
    `Sweep ok [${mode}] — considered=${result.considered} sent=${result.sent} ` +
      `drafted=${result.drafted} skipped=${result.skipped} blocked=${result.blocked} failed=${result.failed}`
  );

  // A blocked send means the price-assertion guard or the allowlist refused
  // something. Never fatal, but it should be visible in the run list.
  if (result.blocked > 0) console.log(`::warning::${result.blocked} message(s) were blocked before sending.`);
  if (result.failed > 0) console.log(`::warning::${result.failed} message(s) failed to send.`);

  process.exit(0);
} catch (error) {
  console.error(`Sweep request failed: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
  process.exit(1);
} finally {
  clearTimeout(timeout);
}
