// Builds the Haiku prompt and invokes `claude -p` for one translation job.
// Pure aside from the injected spawn function — testable with a fake process,
// no credentials, no subscription usage. See docs/phase3_implementation.md
// (private repo), Substage 3.1, "Prompt design" for why this text is fixed
// and shared across all four ask-kinds.

export const SYSTEM_PROMPT = `You are the language-mirroring layer for Kathgodam Taxi's WhatsApp reply system. Kathgodam Taxi is
a taxi service in Uttarakhand, India. You are given a message template that was already fully
composed by a deterministic pricing and business-logic engine — every fact in it (place names, what
is being asked for) is correct and final. Your ONLY job is to re-express that exact template in the
customer's language register, so it reads naturally to them, without changing anything it asks for
or claims.

Hard rules, all more important than sounding natural:
1. Preserve every numbered item exactly — same count, same order, same information requested. Never
   add a new question. Never drop or merge one.
2. Never write, invent, or alter any rupee amount, number, date, or place name. If the template
   contains none, your output must contain none either.
3. Output ONLY in plain English or natural Roman-script Hinglish (Hindi words in the Latin alphabet,
   e.g. "kripya" not "कृपया"). NEVER output Devanagari script or any other script, even if the
   customer wrote in Devanagari.
4. Write as "Kathgodam Taxi", a business — never as a person, never claiming to be human.
5. Keep the tone concise and warm, matching a WhatsApp business reply. Do not add greetings,
   sign-offs, disclaimers, or extra sentences the template doesn't already have.
6. Format every numbered item strictly as a plain digit, period, space — "1. ", "2. ", "3. " — never
   with asterisks, bold markdown, or a colon in place of the period.
7. If unsure how to safely rewrite the template, return it completely unchanged rather than guessing.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

export function buildUserMessage(job) {
  const register = job.languageHint === 'hinglish' ? 'Hinglish (Roman-script Hindi/English mix)' : 'English';
  return [
    `Customer's language register: ${register}`,
    `Message kind: ${job.kind}`,
    `Number of numbered items in the template: ${job.askItemCount}`,
    '',
    'Template (already correct — re-express only, do not add or remove information):',
    job.templateText,
    '',
    'Return the rewritten message as JSON: {"text": "..."}',
  ].join('\n');
}

const JOB_TIMEOUT_MS = 30_000;

// Cheap defensive insurance: with --output-format json --json-schema, the
// CLI's own structured_output field is the verified parse path and normally
// shouldn't need this. Strips a leading/trailing markdown fence on whatever
// text is extracted, before JSON.parse, in case a CLI version or edge case
// still wraps the field in ```json ... ```.
function stripFence(raw) {
  return String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
}

/**
 * Run one translation job through `claude -p`. Never throws — any failure
 * (non-zero exit, malformed output, timeout, spawn error) resolves
 * { jobId, failed: true } so one job's failure never aborts the batch; the
 * caller falls back to the English template exactly as any other validation
 * failure does.
 */
export function runTranslationJob(job, { spawnFn }) {
  return new Promise((resolve) => {
    const args = [
      '-p', buildUserMessage(job),
      '--append-system-prompt', SYSTEM_PROMPT,
      '--model', 'haiku',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(OUTPUT_SCHEMA),
    ];
    // NOT --bare: bare mode requires ANTHROPIC_API_KEY/apiKeyHelper and
    // explicitly does not use subscription login — using it would silently
    // break the no-pay-as-you-go constraint this whole substage exists to
    // satisfy.

    let child;
    try {
      child = spawnFn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ jobId: job.jobId, failed: true });
      return;
    }

    let stdout = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, JOB_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ jobId: job.jobId, failed: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`Job ${job.jobId}: claude exited ${code}`);
        resolve({ jobId: job.jobId, failed: true });
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        if (
          envelope.subtype === 'success' &&
          envelope.structured_output &&
          typeof envelope.structured_output.text === 'string'
        ) {
          resolve({ jobId: job.jobId, text: envelope.structured_output.text });
          return;
        }
        // Defensive fallback for a CLI edge case that didn't honor --json-schema.
        const raw = typeof envelope.result === 'string' ? envelope.result : stdout;
        const parsed = JSON.parse(stripFence(raw));
        if (parsed && typeof parsed.text === 'string') {
          resolve({ jobId: job.jobId, text: parsed.text });
          return;
        }
        throw new Error('no text field in output');
      } catch (error) {
        console.warn(`Job ${job.jobId}: could not parse output (${error.message})`);
        resolve({ jobId: job.jobId, failed: true });
      }
    });
  });
}
