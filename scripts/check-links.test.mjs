/**
 * Tests for scripts/check-links.mjs: every case builds a tiny fixture `build/` directory in a
 * throwaway temp dir and runs the CLI against it, asserting on the exit code and output.
 *
 * Run with: node --test "scripts/*.test.mjs"
 */
import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const CHECK_LINKS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-links.mjs');
const BASE_URL = '/en/latest/';

let workDir;
let buildDir;
let baselinePath;

/** Write a file (creating parent directories) under the fixture build directory. */
function writeBuildFile(relativePath, content) {
  const target = path.join(buildDir, relativePath);
  mkdirSync(path.dirname(target), {recursive: true});
  writeFileSync(target, content);
}

/** Write a baseline listing the given entries. */
function writeBaseline(entries) {
  writeFileSync(baselinePath, JSON.stringify({entries}, null, 2));
}

/** Run check-links against the fixture; resolves with {code, output} whatever the exit code. */
async function runCheckLinks(extraArguments = []) {
  const args = [CHECK_LINKS, '--build', buildDir, '--base-url', BASE_URL, '--baseline', baselinePath, ...extraArguments];
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, args);
    return {code: 0, output: stdout + stderr};
  } catch (error) {
    return {code: error.code, output: String(error.stdout) + String(error.stderr)};
  }
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'check-links-test-'));
  buildDir = path.join(workDir, 'build');
  baselinePath = path.join(workDir, 'baseline.json');
  writeBaseline([]);
  writeBuildFile(
    'index.html',
    '<html><body><a href=/en/latest/a/>A</a> <a href="/en/latest/a/#section">S</a> '
      + '<a href="https://example.com/x">ext</a> <a href="mailto:x@example.com">mail</a> '
      + '<a href="/en/versions/">other site</a> <a href="#">top</a></body></html>',
  );
  writeBuildFile('a/index.html', '<h2 id="section">S</h2><img src="../assets/img/x.png"><a href="../">up</a>');
  writeBuildFile('assets/img/x.png', 'png');
});

afterEach(() => {
  rmSync(workDir, {recursive: true, force: true});
});

test('a clean build with an empty baseline exits 0', async () => {
  const {code} = await runCheckLinks();
  assert.equal(code, 0);
});

test('a new broken link exits 1 and names the page and target', async () => {
  writeBuildFile('b/index.html', '<a href="/en/latest/missing/">gone</a>');
  const {code, output} = await runCheckLinks();
  assert.equal(code, 1);
  assert.match(output, /\/en\/latest\/b\//);
  assert.match(output, /\/en\/latest\/missing\//);
});

test('a broken link that is in the baseline exits 0', async () => {
  writeBuildFile('b/index.html', '<a href="/en/latest/missing/">gone</a>');
  writeBaseline([{page: '/en/latest/b/', attribute: 'href', url: '/en/latest/missing/', reason: 'missing-page'}]);
  const {code} = await runCheckLinks();
  assert.equal(code, 0);
});

test('a baseline entry that now resolves exits 1 so the baseline only shrinks', async () => {
  writeBaseline([{page: '/en/latest/a/', attribute: 'href', url: '../', reason: 'missing-page'}]);
  const {code, output} = await runCheckLinks();
  assert.equal(code, 1);
  assert.match(output, /fixed/i);
});

test('a missing anchor on an existing page is reported', async () => {
  writeBuildFile('b/index.html', '<a href="/en/latest/a/#nope">x</a>');
  const {code, output} = await runCheckLinks();
  assert.equal(code, 1);
  assert.match(output, /missing-anchor/);
});

test('a missing image src is reported', async () => {
  writeBuildFile('b/index.html', '<img src="../assets/img/none.png">');
  const {code, output} = await runCheckLinks();
  assert.equal(code, 1);
  assert.match(output, /none\.png/);
});

test('link lookups are case sensitive, as on GitHub Pages', async () => {
  writeBuildFile('b/index.html', '<a href="/en/latest/A/">x</a>');
  const {code} = await runCheckLinks();
  assert.equal(code, 1);
});

test('percent-encoded file names resolve (attachments such as api#fs#backend.war)', async () => {
  writeBuildFile('assets/attachments/api#fs#backend.war', 'war');
  writeBuildFile('b/index.html', '<a href="/en/latest/assets/attachments/api%23fs%23backend.war">dl</a>');
  const {code} = await runCheckLinks();
  assert.equal(code, 0);
});

test('HTML entities in attribute values are decoded before resolving', async () => {
  writeBuildFile('b/index.html', '<a href="/en/latest/a/?x=1&amp;y=2#section">x</a>');
  const {code} = await runCheckLinks();
  assert.equal(code, 0);
});

test('href-looking text inside escaped code and inside script blocks is ignored', async () => {
  writeBuildFile(
    'b/index.html',
    '<code>&lt;a href=&quot;/en/latest/ghost/&quot;&gt;</code><script>var s = \'<a href="/en/latest/ghost2/">\';</script>',
  );
  const {code} = await runCheckLinks();
  assert.equal(code, 0);
});

test('an empty href is reported as empty-url', async () => {
  writeBuildFile('b/index.html', '<a href="">nothing</a>');
  const {code, output} = await runCheckLinks();
  assert.equal(code, 1);
  assert.match(output, /empty-url/);
});

test('--write-baseline records the current breakage, sorted, and a re-run then passes', async () => {
  writeBuildFile('b/index.html', '<a href="/en/latest/zzz/">x</a><a href="/en/latest/aaa/">y</a>');
  const written = await runCheckLinks(['--write-baseline']);
  assert.equal(written.code, 0);
  const {entries} = JSON.parse(readFileSync(baselinePath, 'utf8'));
  assert.deepEqual(entries.map((entry) => entry.url), ['/en/latest/aaa/', '/en/latest/zzz/']);
  assert.equal((await runCheckLinks()).code, 0);
});

test('a malformed baseline is a usage error (exit 2)', async () => {
  writeFileSync(baselinePath, '{"entries": [{"page": 1}]}');
  assert.equal((await runCheckLinks()).code, 2);
});

test('a base URL outside the allowed shape is a usage error (exit 2)', async () => {
  const args = [CHECK_LINKS, '--build', buildDir, '--base-url', '/evil/', '--baseline', baselinePath];
  await assert.rejects(execFileAsync(process.execPath, args), (error) => error.code === 2);
});

test('--write-baseline keeps the note of an entry that is still broken', async () => {
  writeBuildFile('b/index.html', '<a href="/en/latest/zzz/">x</a>');
  const entry = {page: '/en/latest/b/', attribute: 'href', url: '/en/latest/zzz/', reason: 'missing-page', note: 'explained'};
  writeBaseline([entry]);
  assert.equal((await runCheckLinks(['--write-baseline'])).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(baselinePath, 'utf8')).entries, [entry]);
});
