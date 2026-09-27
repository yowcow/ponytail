#!/usr/bin/env node
// Manifest drift guard for the Muse Code adapter (issue #4). Fails if
// .muse-plugin/plugin.json drops a skill, points a skill at a missing file,
// lets its version drift from the shared version or the marketplace entry,
// or stops passing `muse plugins validate`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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
});

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
  const result = spawnSync('muse', ['plugins', 'validate', '.', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MUSE_EXPERIMENTAL_PLUGINS: 'on' },
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
  const diagnostics = (report.diagnostics || [])
    .map((d) => `${d.severity} ${d.code} ${d.path}: ${d.message}`)
    .join('\n');
  assert.equal(report.valid, true, `muse plugins validate failed:\n${diagnostics}\nstderr: ${result.stderr}`);
});
