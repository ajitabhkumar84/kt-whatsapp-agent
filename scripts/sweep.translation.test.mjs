// Manual test for the runner's Haiku-call parsing/fallback logic.
//
//   node agent-runner/scripts/sweep.translation.test.mjs
//
// Not part of `npm test` in the private repo (that harness only bundles
// src/lib/*.ts from there) — run by hand. Injects a fake spawn so this proves
// parsing/fallback with zero credentials and zero subscription usage.

import { EventEmitter } from 'node:events';
import { runTranslationJob } from './lib/translation-job.mjs';

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

const job = {
  jobId: 'job-1',
  kind: 'ask_details',
  languageHint: 'hinglish',
  templateText: '1. A\n2. B',
  askItemCount: 2,
};

async function run() {
  console.log('\nsweep.translation: well-formed structured_output success');
  {
    const envelope = JSON.stringify({ subtype: 'success', structured_output: { text: 'Rewritten text' } });
    const result = await runTranslationJob(job, { spawnFn: fakeSpawn({ stdout: envelope }) });
    check('parses text from structured_output', result.text === 'Rewritten text' && !result.failed);
  }

  console.log('\nsweep.translation: malformed JSON on stdout');
  {
    const result = await runTranslationJob(job, { spawnFn: fakeSpawn({ stdout: 'not json at all' }) });
    check('falls back to failed:true', result.failed === true);
  }

  console.log('\nsweep.translation: non-zero exit code');
  {
    const result = await runTranslationJob(job, { spawnFn: fakeSpawn({ stdout: '{}', exitCode: 1 }) });
    check('falls back to failed:true on non-zero exit', result.failed === true);
  }

  console.log('\nsweep.translation: spawn itself errors (e.g. claude not on PATH)');
  {
    const result = await runTranslationJob(job, { spawnFn: fakeSpawn({ emitError: true }) });
    check('falls back to failed:true on spawn error', result.failed === true);
  }

  console.log('\nsweep.translation: fenced envelope (defensive fallback path)');
  {
    const envelope = JSON.stringify({ subtype: 'success', result: '```json\n{"text": "Fenced text"}\n```' });
    const result = await runTranslationJob(job, { spawnFn: fakeSpawn({ stdout: envelope }) });
    check('strips the fence and parses text from result', result.text === 'Fenced text' && !result.failed);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
