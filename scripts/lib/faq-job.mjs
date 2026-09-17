// Builds the Haiku prompt and invokes `claude -p` for one FAQ resolution job
// (Substage 3.2). Structural twin of translation-job.mjs — same never-throws
// contract, same injectable spawnFn, same JOB_TIMEOUT_MS — but the content
// decision itself (which shortlisted answer, if any, confidently fits) is
// what Haiku is being asked to make here, unlike translation-job.mjs's pure
// re-expression of an already-decided template.
//
// Rules 2 and 9 below were added 2026-09-16 after a live sandbox run showed
// the FAQ bank's `cancellation-policy` entry (the one answer with a numbered
// 1/2/3 refund-tier list) failing `validateTranslatedText`'s ask-item-count
// guard on 2 out of 2 attempts — not a fluke, a structural gap: this prompt
// had none of translation-job.mjs's numbered-item-preservation rules (its
// rules 1 and 6), and the old rule 7 (kept below as rule 8) actively pushed
// the other way by asking for concise prose. Mirrors translation-job.mjs's
// wording deliberately, for the same reason that file's rules exist.
//
// Rule 6 rewritten under the Cross-Substage Tone & Language Standard, same
// change as translation-job.mjs's own rule 3 — Devanagari in the customer's
// own message is the only trigger for a Devanagari reply; Hinglish input no
// longer mirrors to Hinglish output.
//
// Rules 10-12 and the `source` output field are Part A2 (open-travel-query
// scope expansion): a curated-bank miss no longer always means "no answer" —
// when the private endpoint says this job may go further (job.openTravelQueryEnabled),
// a route-grounded or general-knowledge answer becomes a second, narrower
// option, under its own no-pricing / no-invented-fact guardrails. `source`
// replaces the old plain `matched: boolean` so Call 2 knows which basis (and
// therefore which validation) applies; `null` (mapped to `false` by
// runFaqJob) is the direct successor of the old `matched: false`.
export const SYSTEM_PROMPT_FAQ = `You are the FAQ-answering layer for Kathgodam Taxi's WhatsApp reply system. Kathgodam Taxi is
a taxi service in Uttarakhand, India. You are given a short list of pre-approved question/answer
pairs from the business's own FAQ bank, and a customer's own question (already scrubbed of digit
runs). Decide whether ONE of the listed answers confidently and fully answers the customer's
question; if so, return its key exactly as given, plus a natural rephrasing of ONLY that answer. If
none of the listed answers confidently fits, you may be given a second, narrower option — see rules
10-11 below. If nothing applies, say so rather than guessing.

Hard rules, all more important than sounding natural:
1. Never blend, combine, or borrow from more than one listed answer. Pick exactly one, or none.
2. If the selected answer contains a numbered list, preserve every numbered item exactly — same
   count, same order, same information. Never merge, drop, or summarize any of them into flowing
   prose, even to sound more natural or concise.
3. Never add a fact, number, date, or place the selected bank answer does not already state.
4. If genuinely unsure, or the question does not match any listed answer well and no other option
   below applies, set source to null and return no key and no text — a human will handle it. A false
   "no match" costs nothing; a wrong or invented answer costs the business's credibility.
5. Return the selected key EXACTLY as given in the candidate list — never invent, abbreviate, or
   alter it. Only set a key when source is "faqBank".
6. Reply in clean, natural English by default. Reply in Hindi, in Devanagari script, ONLY when the
   customer's own language register (given below) is Devanagari. Never mirror a Romanized-Hindi/
   Hinglish register with Hinglish output — render it in clean English instead.
7. Write as "Kathgodam Taxi", a business — never as a person, never claiming to be human.
8. Keep the tone concise and direct — 1 to 3 short sentences, matching a WhatsApp business reply. Do
   not add greetings, sign-offs, disclaimers, or filler — but rule 2's numbered items are never
   optional padding, so shortening them for concision is not allowed.
9. Format every numbered item strictly as a plain digit, period, space — "1. ", "2. ", "3. " — never
   with asterisks, bold markdown, or a colon in place of the period.
10. If you are given route facts below and the question is about that specific route (distance,
    duration, what's along the way), you may answer using ONLY those given facts — set source to
    "grounded". Never state a distance or duration figure other than exactly what you were given;
    never guess a figure for a route you were not given facts for.
11. If you are told you may answer general travel/service questions and the question is a genuine,
    answerable one you are confident about from general knowledge (not specific to a route's own
    facts, e.g. "will luggage fit in a hatchback") — set source to "general". Under "general", you
    must NEVER state a rupee figure under any circumstances; if the question needs pricing, say that
    fixed fares are generated from the route catalog, without naming a number. Never use language
    implying a booking is placed, confirmed, or reserved — only the deterministic booking system does
    that.
12. Set source to exactly one of "faqBank", "grounded", "general", matching which basis you actually
    used, or to null if none applies.`;

const OUTPUT_SCHEMA_FAQ = {
  type: 'object',
  properties: {
    source: { type: ['string', 'null'], enum: ['faqBank', 'grounded', 'general', null] },
    faqKey: { type: ['string', 'null'] },
    text: { type: ['string', 'null'] },
  },
  required: ['source'],
};

// Same pattern the private repo's src/lib/translation.ts uses for
// countAskItems — duplicated here rather than shared, since this repo has no
// access to that one's src/lib. Only used to annotate each candidate with its
// own numbered-item count below; the private repo's validateTranslatedText
// still re-derives the real count from the authoritative answer independently
// at Call-2 time and is the actual enforcement point, not this annotation.
const ASK_ITEM_PATTERN = /^\s*(?:\*\*)?\d+[.):](?:\*\*)?\s+/gm;
function countAskItems(text) {
  return (String(text || '').match(ASK_ITEM_PATTERN) || []).length;
}

// Never log the candidate list, the scrubbed question, or the parsed result
// anywhere in this file — only jobId and the same class of generic CLI
// diagnostics translation-job.mjs already restricts itself to. This mirrors
// that file's own logging discipline line for line.
export function buildFaqUserMessage(job) {
  const register = job.languageHint === 'devanagari' ? 'Devanagari (Hindi script)' : 'English';
  const candidates = (job.faqCandidates || [])
    .map((c, i) => {
      const itemCount = countAskItems(c.answer);
      const itemNote =
        itemCount > 0
          ? ` (contains ${itemCount} numbered item${itemCount === 1 ? '' : 's'} — if you select this one, your rephrasing must keep all ${itemCount})`
          : '';
      return `Candidate ${i + 1}\nKey: ${c.key}\nQuestion: ${c.question}\nAnswer: ${c.answer}${itemNote}`;
    })
    .join('\n\n');

  const lines = [
    'Candidate FAQ answers (pick at most one, or none):',
    '',
    candidates || '(none)',
    '',
  ];

  // Part A2. Only present at all when the private endpoint has authorized
  // going beyond the curated bank — an un-updated job (or one from before
  // this scope expansion) simply omits this, and the prompt above already
  // reads correctly without it (rules 10-11 never apply).
  if (job.openTravelQueryEnabled) {
    lines.push(
      'If none of the candidates above confidently answers, you may ALSO use ONE of the following, subject to rules 10-11:'
    );
    if (job.routeContext) {
      const rc = job.routeContext;
      const attractionsLine = rc.attractions && rc.attractions.length
        ? ` Notable attractions along the way: ${rc.attractions.join(', ')}.`
        : '';
      lines.push(
        `- Route facts for ${rc.from} to ${rc.to} (use ONLY these, never invent your own): distance ${rc.distance || 'unknown'}, journey duration ${rc.duration || 'unknown'}.${attractionsLine}`
      );
    }
    lines.push(
      '- Or, if it is a general travel/service question you can answer confidently and safely from general knowledge, answer it directly (source: "general").',
      ''
    );
  }

  lines.push(
    `Customer's question (already scrubbed of digit runs): ${job.scrubbedQuestion || ''}`,
    '',
    `Customer's language register: ${register}`
  );
  return lines.join('\n');
}

// Same value as translation-job.mjs's JOB_TIMEOUT_MS, reused as-is — that
// value came from a real 2026-09-15 live incident (a cold `claude -p`
// invocation exceeding 30s and getting SIGKILLed), not re-tuned here.
const JOB_TIMEOUT_MS = 60_000;

function stripFence(raw) {
  return String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
}

const STDERR_SNIPPET_LEN = 300;

/**
 * Run one FAQ job through `claude -p`. Never throws — any failure (non-zero
 * exit, malformed output, timeout, spawn error) resolves { jobId, failed:
 * true } so one job's failure never aborts the batch; the caller (Call 2, on
 * the private side) falls back to the ordinary holding message exactly as
 * any other rejection does — there is no safe single fallback answer for an
 * FAQ job the way there is a templateText for an ask-kind one.
 */
export function runFaqJob(job, { spawnFn, timeoutMs = JOB_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const args = [
      '-p', buildFaqUserMessage(job),
      '--append-system-prompt', SYSTEM_PROMPT_FAQ,
      '--model', 'haiku',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(OUTPUT_SCHEMA_FAQ),
    ];
    // NOT --bare — see translation-job.mjs's own note: bare mode requires
    // ANTHROPIC_API_KEY/apiKeyHelper and does not use subscription login.

    let child;
    try {
      child = spawnFn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      console.warn(`Job ${job.jobId}: spawn failed (${error.message})`);
      resolve({ jobId: job.jobId, failed: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    const stderrSnippet = () => (stderr ? ` — stderr: ${stderr.slice(0, STDERR_SNIPPET_LEN).trim()}` : '');

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => {
      clearTimeout(timer);
      console.warn(`Job ${job.jobId}: spawn error (${error.message})`);
      resolve({ jobId: job.jobId, failed: true });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = timedOut
          ? `timed out after ${timeoutMs / 1000}s`
          : `claude exited ${code}${signal ? ` (signal ${signal})` : ''}`;
        console.warn(`Job ${job.jobId}: ${detail}${stderrSnippet()}`);
        resolve({ jobId: job.jobId, failed: true });
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        if (
          envelope.subtype === 'success' &&
          envelope.structured_output &&
          (typeof envelope.structured_output.source === 'string' || envelope.structured_output.source === null)
        ) {
          const out = envelope.structured_output;
          const source = out.source || false;
          resolve({
            jobId: job.jobId,
            source,
            selectedFaqKey: source === 'faqBank' ? out.faqKey ?? undefined : undefined,
            text: source ? out.text ?? undefined : undefined,
          });
          return;
        }
        // Defensive fallback for a CLI edge case that didn't honor --json-schema.
        const raw = typeof envelope.result === 'string' ? envelope.result : stdout;
        const parsed = JSON.parse(stripFence(raw));
        if (parsed && (typeof parsed.source === 'string' || parsed.source === null)) {
          const source = parsed.source || false;
          resolve({
            jobId: job.jobId,
            source,
            selectedFaqKey: source === 'faqBank' ? parsed.faqKey ?? undefined : undefined,
            text: source ? parsed.text ?? undefined : undefined,
          });
          return;
        }
        throw new Error('no source field in output');
      } catch (error) {
        console.warn(`Job ${job.jobId}: could not parse output (${error.message})${stderrSnippet()}`);
        resolve({ jobId: job.jobId, failed: true });
      }
    });
  });
}
