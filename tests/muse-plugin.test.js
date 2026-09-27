#!/usr/bin/env node
// Manifest drift guard for the Muse Code adapter (issue #4). Fails if
// .muse-plugin/plugin.json drops a skill, points a skill at a missing file,
// lets its version drift from the shared version or the marketplace entry,
// or stops passing `muse plugins validate`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const PLUGIN_MANIFEST = '.muse-plugin/plugin.json';
const MARKETPLACE_MANIFEST = '.muse-plugin/marketplace.json';
const PACKAGE_MANIFEST = 'package.json';
// The six skills the adapter exposes; capabilities.skills must list exactly these.
const EXPECTED_SKILLS = [
  'ponytail',
  'ponytail-review',
  'ponytail-audit',
  'ponytail-debt',
  'ponytail-gain',
  'ponytail-help',
];
// Floating refs are a supply-chain footgun; versions must stay pinned.
const PINNED_SEMVER = /^\d+\.\d+\.\d+$/;

// Read inside each test (not at module scope) so a missing or malformed
// manifest surfaces as a clean per-test assertion failure, not a load-time
// crash that collapses every case into one unreadable stack trace.
function load(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));
}

test('capabilities.skills lists the six skills with resolvable paths', () => {
  const manifest = load(PLUGIN_MANIFEST);
  const skills = manifest.capabilities && manifest.capabilities.skills;
  assert.ok(Array.isArray(skills), 'capabilities.skills must be an array');
  assert.deepEqual(
    skills.map((s) => s.id).sort(),
    [...EXPECTED_SKILLS].sort(),
  );
  for (const skill of skills) {
    assert.ok(skill.path, `skill ${skill.id} must declare a path`);
    assert.equal(skill.path, `skills/${skill.id}/SKILL.md`, `skill ${skill.id} mispoints at ${skill.path}`);
    assert.ok(
      fs.existsSync(path.join(root, skill.path)),
      `skill path missing: ${skill.path}`,
    );
  }
  // Reverse drift: every skills/<name>/SKILL.md on disk must be registered.
  const skillDirs = fs.readdirSync(path.join(root, 'skills')).filter((name) =>
    fs.existsSync(path.join(root, 'skills', name, 'SKILL.md')),
  );
  assert.deepEqual(
    [...skillDirs].sort(),
    skills.map((s) => s.id).sort(),
    'unregistered skill on disk: capabilities.skills must list every skills/<name>/SKILL.md',
  );
});

// NB: pin + plugin/package agreement intentionally overlaps scripts/check-versions.js
// (9-file + tag guard); the marketplace-entry version check lives only here.
test('versions agree across plugin, marketplace entry, and package', () => {
  const pluginVersion = load(PLUGIN_MANIFEST).version;
  const marketplace = load(MARKETPLACE_MANIFEST);
  const entry = (marketplace.plugins || []).find((p) => p.name === 'ponytail');
  assert.ok(entry, 'marketplace must carry a ponytail plugins entry');
  const packageVersion = load(PACKAGE_MANIFEST).version;
  for (const [rel, version] of [
    [PLUGIN_MANIFEST, pluginVersion],
    [MARKETPLACE_MANIFEST, entry.version],
    [PACKAGE_MANIFEST, packageVersion],
  ]) {
    assert.match(String(version), PINNED_SEMVER, `${rel} version must be pinned semver`);
  }
  assert.equal(entry.version, pluginVersion);
  assert.equal(packageVersion, pluginVersion);
});

test('muse plugins validate passes', (t) => {
  // `plugins` commands sit behind the experimental plugins gate; without the
  // cached feature flags of an interactive login (fresh HOME, CI) `validate`
  // refuses with "plugins are not available in this build".
  // Validate a pristine export of the committed tree, not the live worktree:
  // `muse plugins validate` scans the whole target dir and fails closed on
  // symlink entries, so build artifacts like ponytail-mcp/node_modules/.bin
  // (installed by CI before the tests run) would fail validation even though
  // the committed package is clean.
  // NB: this validates committed HEAD, not the worktree — uncommitted
  // schema-only edits surface at CI (which tests the commit itself), while
  // live-tree id/path/version drift is already caught by the two tests above.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-muse-validate-'));
  try {
    const archive = spawnSync('git', ['archive', 'HEAD'], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    });
    if (archive.error && archive.error.code === 'ENOENT') {
      t.skip('git not available');
      return;
    }
    assert.equal(archive.status, 0, `git archive HEAD failed: ${archive.stderr}${archive.error ? ` (${archive.error})` : ''}`);
    const untar = spawnSync('tar', ['-x', '-C', stage], { input: archive.stdout, timeout: 120_000 });
    if (untar.error && untar.error.code === 'ENOENT') {
      t.skip('tar not available');
      return;
    }
    assert.equal(untar.status, 0, `unpacking pristine tree failed: ${untar.stderr}${untar.error ? ` (${untar.error})` : ''}`);
    const result = spawnSync('muse', ['plugins', 'validate', stage, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, MUSE_EXPERIMENTAL_PLUGINS: 'on' },
      timeout: 120_000,
    });
    if (result.error && result.error.code === 'ENOENT') {
      t.skip('muse CLI not available');
      return;
    }
    // Surface the structured diagnostics on failure: the exit code alone hides
    // which check reported what, which is exactly what a CI log needs to show.
    let report = null;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      assert.fail(`muse plugins validate emitted no JSON report (exit ${result.status}): ${result.stderr}${result.stdout}`);
    }
    if (typeof report !== 'object' || report === null) {
      assert.fail(`muse plugins validate emitted non-object JSON report (exit ${result.status}): ${result.stderr}${result.stdout}`);
    }
    const diagnostics = (Array.isArray(report.diagnostics) ? report.diagnostics : [])
      .map((d) => `${d.severity} ${d.code} ${d.path}: ${d.message}`)
      .join('\n');
    assert.equal(report.valid, true, `muse plugins validate failed:\n${diagnostics}\nstderr: ${result.stderr}${result.error ? ` (${result.error})` : ''}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
