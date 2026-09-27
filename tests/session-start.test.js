#!/usr/bin/env node
// hooks/session-start (PR #7): the stub must always exit 0 with valid JSON,
// even when cksum is missing or the install path exceeds its 100-char budget.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const hook = path.join(root, 'hooks', 'session-start');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-session-start-'));
// Runs on normal exit and on assertion-throw exit; force makes it idempotent.
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));

function bashPresent() {
  try {
    return spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

// A plugin tree whose root exceeds the 100-char budget, so the hook takes
// its cksum-suffix truncation branch. The script locates its tree from $0,
// so a copy under <deep>/hooks/ is enough — no full-tree copy needed.
function longPathHook() {
  const deep = path.join(temp, `p${'a'.repeat(120)}`);
  const dir = path.join(deep, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, 'session-start');
  fs.copyFileSync(hook, copy);
  return copy;
}

// PATH holding bash but no cksum, so the truncation branch runs without it.
function bashOnlyPath() {
  const out = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
  const bin = path.join(temp, 'bash-only-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(out.stdout.trim(), path.join(bin, 'bash'));
  return bin;
}

function parseStdout(r) {
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('emits a SessionStart block on a normal path', (t) => {
  if (!bashPresent()) {
    t.skip('bash not available');
    return;
  }
  const body = parseStdout(spawnSync('bash', [hook], { encoding: 'utf8' }));
  assert.equal(body.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(body.hookSpecificOutput.additionalContext.includes('ponytail-bootstrap'));
});

test('long install path truncates with a cksum identity', (t) => {
  if (!bashPresent()) {
    t.skip('bash not available');
    return;
  }
  const body = parseStdout(spawnSync('bash', [longPathHook()], { encoding: 'utf8' }));
  assert.equal(body.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(body.hookSpecificOutput.additionalContext, /\.\.\.[0-9]+:/);
});

test('still exits 0 with valid JSON when cksum is missing', (t) => {
  if (!bashPresent()) {
    t.skip('bash not available');
    return;
  }
  const r = spawnSync('bash', [longPathHook()], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bashOnlyPath() },
  });
  const body = parseStdout(r);
  assert.equal(body.hookSpecificOutput.hookEventName, 'SessionStart');
});
