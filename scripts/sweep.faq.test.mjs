// Manual test for the runner's FAQ-job (Substage 3.2) parsing/fallback logic.
//
//   node agent-runner/scripts/sweep.faq.test.mjs
//
// Not part of `npm test` in the private repo (that harness only bundles
// src/lib/*.ts from there) — run by hand, mirroring sweep.translation.test.mjs.
// Injects a fake spawn so this proves parsing/fallback with zero credentials
// and zero subscription usage.

import { EventEmitter } from 'node:events';
import { runFaqJob, buildFaqUserMessage } from './lib/faq-job.mjs';

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

function fakeSpawn({ stdout = '', exitCode = 0, emitError = false }) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (emitError) {
        child.emit('error', new Error('spawn ENOENT'));
        return;
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    });
    return child;
  };
}

function fakeHangingSpawn() {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      setImmediate(() => child.emit('close', null, signal));
    };
    return child;
  };
}

const job = {
  jobId: 'job-faq-1',
  kind: 'faq_answer',
  languageHint: 'devanagari',
  faqCandidates: [
    { key: 'cancellation-policy', question: 'What is your cancellation policy?', answer: 'Free cancellation up to 24 hours before pickup.' },
    { key: 'ac-charge', question: 'Is AC available?', answer: 'Yes, all cars are AC. An extra ₹400 applies for hill routes.' },
  ],
  scrubbedQuestion: 'cancellation policy kya hai',
};

async function run() {
  console.log('\nsweep.faq: well-formed structured_output success (faqBank match)');
  {
    const envelope = JSON.stringify({
      subtype: 'success',
      structured_output: { source: 'faqBank', faqKey: 'cancellation-policy', text: 'You can cancel free up to 24 hours before pickup.' },
    });
    const result = await runFaqJob(job, { spawnFn: fakeSpawn({ stdout: envelope }) });
    check(
      'parses source/selectedFaqKey/text from structured_output',
      result.source === 'faqBank' && result.selectedFaqKey === 'cancellation-policy' && !!result.text && !result.failed
    );
  }

  console.log('\nsweep.faq: well-formed structured_output success (no confident match)');
  {
    const envelope = JSON.stringify({ subtype: 'success', structured_output: { source: null, faqKey: null, text: null } });
    const result = await runFaqJob(job, { spawnFn: fakeSpawn({ stdout: envelope }) });
    check(
      'a genuine no-match reports source:false with no key/text, not a failure',
      result.source === false && result.selectedFaqKey === undefined && result.text === undefined && !result.failed
    );
  }

  console.log('\nsweep.faq: well-formed structured_output success (Part A2: grounded)');
  {
    const envelope = JSON.stringify({
      subtype: 'success',
      structured_output: { source: 'grounded', faqKey: null, text: 'Kathgodam to Nainital is 34 KM, about 1 Hour.' },
    });
    const result = await runFaqJob(job, { spawnFn: fakeSpawn({ stdout: envelope }) });
    check(
      'parses source: grounded with text but no selectedFaqKey',
      result.source === 'grounded' && result.selectedFaqKey === undefined && !!result.text && !result.failed
    );
  }

  console.log('\nsweep.faq: well-formed structured_output success (Part A2: general)');
  {
    const envelope = JSON.stringify({
      subtype: 'success',
      structured_output: { source: 'general', faqKey: null, text: 'A hatchback comfortably fits two medium suitcases.' },
    });
    const result = await runFaqJob(job, { spawnFn: fakeSpawn({ stdout: envelope }) });
    check(
      'parses source: general with text but no selectedFaqKey',
      result.source === 'general' && result.selectedFaqKey === undefined && !!result.text && !result.failed
    );
  }

  console.log('\nsweep.faq: malformed JSON on stdout');
  {
    const result = await runFaqJob(job, { spawnFn: fakeSpawn({ stdout: 'not json at all' }) });
    check('falls back to failed:true', result.failed === true);
  }

  console.log('\nsweep.faq: non-zero exit code');
  {
    const result = await runFaqJob(job, { spawnFn: fakeSpawn({ stdout: '{}', exitCode: 1 }) });
    check('falls back to failed:true on non-zero exit', result.failed === true);
  }

  console.log('\nsweep.faq: spawn itself errors (e.g. claude not on PATH)');
  {
    const result = await runFaqJob(job, { spawnFn: fakeSpawn({ emitError: true }) });
    check('falls back to failed:true on spawn error', result.failed === true);
  }

  console.log('\nsweep.faq: fenced envelope (defensive fallback path)');
  {
    const envelope = JSON.stringify({
      subtype: 'success',
      result: '```json\n{"source": "faqBank", "faqKey": "ac-charge", "text": "Yes, all cars have AC — hill routes carry an extra charge."}\n```',
    });
    const result = await runFaqJob(job, { spawnFn: fakeSpawn({ stdout: envelope }) });
    check(
      'strips the fence and parses the fields from result',
      result.source === 'faqBank' && result.selectedFaqKey === 'ac-charge' && !result.failed
    );
  }

  console.log('\nsweep.faq: per-job timeout kills a hung process');
  {
    const result = await runFaqJob(job, { spawnFn: fakeHangingSpawn(), timeoutMs: 20 });
    check('falls back to failed:true once the timeout fires', result.failed === true);
  }

  console.log('\nsweep.faq: buildFaqUserMessage never logs candidate content, only builds it');
  {
    // Not a "never logs" runtime assertion (that lives in code review — see
    // faq-job.mjs's own comment) — this just proves the shortlist and
    // scrubbed question actually reach the prompt Haiku sees, so a human
    // reviewing this test can see the shape without it ever hitting a log
    // line anywhere in this file.
    const message = buildFaqUserMessage(job);
    check('includes every candidate key', job.faqCandidates.every((c) => message.includes(c.key)));
    check('includes the scrubbed question', message.includes(job.scrubbedQuestion));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
