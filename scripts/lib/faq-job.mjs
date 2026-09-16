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
export const SYSTEM_PROMPT_FAQ = `You are the FAQ-answering layer for Kathgodam Taxi's WhatsApp reply system. Kathgodam Taxi is
a taxi service in Uttarakhand, India. You are given a short list of pre-approved question/answer
pairs from the business's own FAQ bank, and a customer's own question (already scrubbed of digit
runs). Decide whether ONE of the listed answers confidently and fully answers the customer's
question; if so, return its key exactly as given, plus a natural rephrasing of ONLY that answer. If
none of the listed answers confidently fits, say so rather than guessing.

Hard rules, all more important than sounding natural:
1. Never blend, combine, or borrow from more than one listed answer. Pick exactly one, or none.
2. If the selected answer contains a numbered list, preserve every numbered item exactly — same
   count, same order, same information. Never merge, drop, or summarize any of them into flowing
   prose, even to sound more natural or concise.
3. Never add a fact, number, date, or place the selected answer does not already state.
4. If genuinely unsure, or the question does not match any listed answer well, set matched to false
   and return no key and no text — a human will handle it. A false "no match" costs nothing; a wrong
   or invented answer costs the business's credibility.
5. Return the selected key EXACTLY as given in the candidate list — never invent, abbreviate, or
   alter it.
6. Output ONLY in plain English or natural Roman-script Hinglish (Hindi words in the Latin alphabet,
   e.g. "kripya" not "कृपया"), matching the customer's own register. NEVER output Devanagari script
   or any other script, even if the customer wrote in Devanagari.
7. Write as "Kathgodam Taxi", a business — never as a person, never claiming to be human.
8. Keep the tone concise and warm, matching a WhatsApp business reply. Do not add greetings,
   sign-offs, disclaimers, or extra sentences the selected answer doesn't already support — but rule 2's
   numbered items are never optional padding, so shortening them for concision is not allowed.
9. Format every numbered item strictly as a plain digit, period, space — "1. ", "2. ", "3. " — never
   with asterisks, bold markdown, or a colon in place of the period.`;

const OUTPUT_SCHEMA_FAQ = {
  type: 'object',
  properties: {
    matched: { type: 'boolean' },
    faqKey: { type: ['string', 'null'] },
    text: { type: ['string', 'null'] },
  },
  required: ['matched'],
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
  const register = job.languageHint === 'hinglish' ? 'Hinglish (Roman-script Hindi/English mix)' : 'English';
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
  return [
    'Candidate FAQ answers (pick at most one, or none):',
    '',
    candidates,
    '',
    `Customer's question (already scrubbed of digit runs): ${job.scrubbedQuestion || ''}`,
    '',
    `Customer's language register: ${register}`,
  ].join('\n');
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
        if (envelope.subtype === 'success' && envelope.structured_output && typeof envelope.structured_output.matched === 'boolean') {
          const out = envelope.structured_output;
          resolve({
            jobId: job.jobId,
            matched: out.matched,
            selectedFaqKey: out.matched ? out.faqKey ?? undefined : undefined,
            text: out.matched ? out.text ?? undefined : undefined,
          });
          return;
        }
        // Defensive fallback for a CLI edge case that didn't honor --json-schema.
        const raw = typeof envelope.result === 'string' ? envelope.result : stdout;
        const parsed = JSON.parse(stripFence(raw));
        if (parsed && typeof parsed.matched === 'boolean') {
          resolve({
            jobId: job.jobId,
            matched: parsed.matched,
            selectedFaqKey: parsed.matched ? parsed.faqKey ?? undefined : undefined,
            text: parsed.matched ? parsed.text ?? undefined : undefined,
          });
          return;
        }
        throw new Error('no matched field in output');
      } catch (error) {
        console.warn(`Job ${job.jobId}: could not parse output (${error.message})${stderrSnippet()}`);
        resolve({ jobId: job.jobId, failed: true });
      }
    });
  });
}
