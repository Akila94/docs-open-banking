/**
 * Tests for stage 2 of the converter (spec §3 passes 9–14): HTML -> JSX, MDX escaping, autolinks,
 * MkDocs link resolution, MkDocs-compatible heading ids, page titles and smartsymbols.
 *
 * Every directory under `test/fixtures-inline/` holds `input.md` (MkDocs source), a hand-written
 * `expected.md` and `ctx.json`:
 *   {"file": "<docs-relative path>", "nav": {"<file>": "<label>"}, "files": [...], "staticFiles": [...],
 *    "navFiles": [...] (optional: enables `displayed_sidebar` for pages outside it),
 *    "report": {"brokenLinks": [{line, href}], "missingImages": [{line, src}]}}
 * `files`/`staticFiles` are the docs-relative paths that exist (the page itself is always added).
 * For each fixture the full conversion must equal `expected.md`, `expected.md` must compile as
 * MDX, and converting `expected.md` again must not change it (idempotent; no double escaping).
 */
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {compile} from '@mdx-js/mdx';
import remarkDirective from 'remark-directive';
import remarkGfm from 'remark-gfm';
import GithubSlugger from 'github-slugger';

import {convertFile} from '../lib/pipeline.mjs';
import {htmlToJsx} from '../lib/html-to-jsx.mjs';
import {resolveMkdocsLink} from '../lib/links.mjs';
import {mkdocsSlugify, mkdocsUnique, docusaurusSlug} from '../lib/slug.mjs';
import {ConversionError} from '../lib/errors.mjs';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures-inline');
const SITE_NAME = 'WSO2 Open Banking Accelerator Documentation';
const SITE_URL = 'https://ob.docs.wso2.com/en/latest/';

/**
 * Build the stage-2 site context for a fixture.
 *
 * @param {object} fixtureCtx Parsed `ctx.json`.
 * @returns {object} `ctx.site` for `convertFile`.
 */
function siteContext(fixtureCtx) {
  const existing = new Set([fixtureCtx.file, ...(fixtureCtx.files ?? []), ...(fixtureCtx.staticFiles ?? [])]);
  return {
    existsFn: (relative) => existing.has(relative),
    titles: new Map(Object.entries(fixtureCtx.nav ?? {})),
    siteName: SITE_NAME,
    siteUrl: SITE_URL,
    ...(fixtureCtx.navFiles ? {navFiles: new Set(fixtureCtx.navFiles)} : {}),
  };
}

/**
 * Load every inline fixture in a stable order.
 *
 * @returns {Array<{name: string, input: string, expected: string, ctx: object}>} Fixtures.
 */
function loadFixtures() {
  return readdirSync(FIXTURES_DIR, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = path.join(FIXTURES_DIR, name);
      return {
        name,
        input: readFileSync(path.join(dir, 'input.md'), 'utf8'),
        expected: readFileSync(path.join(dir, 'expected.md'), 'utf8'),
        ctx: existsSync(path.join(dir, 'ctx.json')) ? JSON.parse(readFileSync(path.join(dir, 'ctx.json'), 'utf8')) : {},
      };
    });
}

/**
 * Run the full conversion (stage 1 + stage 2) for a fixture.
 *
 * @param {string} source File content.
 * @param {object} fixtureCtx Parsed `ctx.json`.
 * @returns {{text: string, report: object}} Converted file and its report.
 */
function convertFull(source, fixtureCtx) {
  return convertFile(source, {file: fixtureCtx.file, site: siteContext(fixtureCtx)});
}

const fixtures = loadFixtures();

describe('inline conversion fixtures', () => {
  test('fixture set covers the brief', () => {
    const names = fixtures.map((fixture) => fixture.name);
    for (const required of ['escape-prose', 'autolink', 'html-table', 'catalog-pre', 'index-cards', 'links', 'heading-ids', 'smartsymbols']) {
      assert.ok(names.includes(required), `missing fixture ${required}`);
    }
  });

  for (const fixture of fixtures) {
    test(`${fixture.name}: converts to expected.md`, () => {
      assert.equal(convertFull(fixture.input, fixture.ctx).text, fixture.expected);
    });

    test(`${fixture.name}: expected.md compiles as MDX`, async () => {
      await compile(fixture.expected, {remarkPlugins: [remarkGfm, remarkDirective]});
    });

    test(`${fixture.name}: converting expected.md again changes nothing`, () => {
      assert.equal(convertFull(fixture.expected, fixture.ctx).text, fixture.expected);
    });

    if (fixture.ctx.report) {
      test(`${fixture.name}: reports broken links and missing images`, () => {
        const {report} = convertFull(fixture.input, fixture.ctx);
        assert.deepEqual(report.brokenLinks.map(({line, href}) => ({line, href})), fixture.ctx.report.brokenLinks);
        assert.deepEqual(report.missingImages.map(({line, src}) => ({line, src})), fixture.ctx.report.missingImages);
      });
    }
  }
});

describe('htmlToJsx security', () => {
  /**
   * Assert that `htmlToJsx` rejects some HTML with a located ConversionError.
   *
   * @param {string} html Input HTML.
   * @param {object} [opts] Options.
   */
  function assertRejected(html, opts = {}) {
    assert.throws(
      () => htmlToJsx(html, {file: 'page.md', allowOnclick: false, ...opts}),
      (error) => error instanceof ConversionError && error.message.startsWith('page.md:'),
    );
  }

  test('throws on an onclick attribute when allowOnclick is false', () => {
    assertRejected('<div onclick="x">a</div>');
  });

  test('throws on any other on* attribute even when allowOnclick is true', () => {
    assertRejected('<img src="a.png" onerror="alert(1)">', {allowOnclick: true});
  });

  test('throws on javascript: URLs, including obfuscated ones', () => {
    assertRejected('<a href="javascript:alert(1)">x</a>');
    assertRejected('<a href=" JaVa&#x09;Script:alert(1)">x</a>');
  });

  test('throws on script and iframe outside their allow-listed pages', () => {
    assertRejected('<script src="x.js"></script>');
    assertRejected('<iframe src="https://www.youtube.com/embed/x"></iframe>');
  });

  test('throws on an onclick that is not a location.href card', () => {
    assertRejected('<div class="card" onclick="fetch(\'/x\')">a</div>', {allowOnclick: true});
  });
});

describe('htmlToJsx output', () => {
  test('pre content becomes an exact template literal (backtick, backslash, ${)', () => {
    const out = htmlToJsx('<pre><code>a `b` \\c ${d}\n  e\n</code></pre>', {file: 'page.md', allowOnclick: false});
    assert.equal(out, '<pre><code>{`a \\`b\\` \\\\c \\${d}\n\\x20 e\n`}</code></pre>');
  });

  test('is a fixed point on its own output', () => {
    const samples = [
      '<table>\n  <tr>\n    <th style="width:40%">A</th>\n    <td>\n      x {y} `z` <b>bold</b>\n    </td>\n  </tr>\n</table>',
      '<div class="a">\n  <code>[k]</code>\n  <span>Required</span>\n  <!-- note -->\n  <p>t: <IS_HOME></p>\n</div>',
      '<pre>\n<code class="toml">x = "${a}"\n\n  y = `b`\n</code>\n</pre>',
    ];
    for (const sample of samples) {
      const once = htmlToJsx(sample, {file: 'page.md', allowOnclick: false});
      assert.equal(htmlToJsx(once, {file: 'page.md', allowOnclick: false, converted: true}), once);
    }
  });
});

describe('resolveMkdocsLink', () => {
  const existing = new Set([
    'learn/page.md', 'learn/other.md', 'get-started/try-out-flow.md', 'develop/java/consent-core-service.md',
    'assets/attachments/x.zip', 'assets/attachments/api#fs#backend.war', 'assets/img/a.png', 'internal-apis/spec.yaml',
  ]);
  const existsFn = (relative) => existing.has(relative);
  const resolve = (href, from = 'learn/page.md', options = {}) => resolveMkdocsLink(href, from, '/docs', existsFn, {siteUrl: SITE_URL, ...options});

  test('keeps a file-relative doc link and its anchor', () => {
    assert.deepEqual(resolve('other.md#a'), {kind: 'doc', out: 'other.md#a'});
  });

  test('decodes %2F the way MkDocs does', () => {
    assert.deepEqual(resolve('..%2Fget-started%2Ftry-out-flow.md'), {kind: 'doc', out: '../get-started/try-out-flow.md'});
  });

  test('maps attachments and specs to pathname:// with MkDocs quoting', () => {
    assert.deepEqual(resolve('../assets/attachments/x.zip'), {kind: 'static', out: 'pathname:///assets/attachments/x.zip'});
    assert.deepEqual(resolve('../assets/attachments/api%23fs%23backend.war'), {kind: 'static', out: 'pathname:///assets/attachments/api%23fs%23backend.war'});
    assert.deepEqual(resolve('../internal-apis/spec.yaml'), {kind: 'static', out: 'pathname:///internal-apis/spec.yaml'});
  });

  test('resolves asset links written relative to the page URL', () => {
    assert.deepEqual(resolve('../../assets/attachments/x.zip'), {kind: 'static', out: 'pathname:///assets/attachments/x.zip'});
  });

  test('resolves a directory-style page-relative doc link', () => {
    assert.deepEqual(resolve('../consent-core-service/', 'develop/java/consent-amendment-history.md'), {kind: 'doc', out: 'consent-core-service.md'});
  });

  test('keeps absolute and external links', () => {
    assert.deepEqual(resolve('https://ob.docs.wso2.com/en/latest/learn/x/'), {kind: 'external', out: 'https://ob.docs.wso2.com/en/latest/learn/x/'});
    assert.deepEqual(resolve('mailto:a@b.c'), {kind: 'external', out: 'mailto:a@b.c'});
    assert.deepEqual(resolve('#top'), {kind: 'anchor', out: '#top'});
  });

  test('keeps broken links broken at the same final URL', () => {
    assert.deepEqual(resolve('missing.md#x'), {kind: 'broken', out: 'pathname:///learn/page/missing.md#x'});
    assert.deepEqual(resolve('../../../escape.md'), {kind: 'broken', out: 'https://ob.docs.wso2.com/en/escape.md'});
    assert.deepEqual(resolve('/develop/java/x#a'), {kind: 'broken', out: 'https://ob.docs.wso2.com/develop/java/x#a'});
    assert.deepEqual(resolve(''), {kind: 'broken', out: ''});
  });

  test('images: existing ones file-relative, missing ones unchanged', () => {
    assert.deepEqual(resolve('..%2Fassets%2Fimg%2Fa.png', 'learn/page.md', {image: true}), {kind: 'image', out: '../assets/img/a.png'});
    assert.deepEqual(resolve('../assets/img/missing.png', 'learn/page.md', {image: true}), {kind: 'broken', out: '../assets/img/missing.png'});
  });

  test('links to image files keep MkDocs\'s URL via pathname:// (the postBuild plugin serves them)', () => {
    assert.deepEqual(resolve('..%2Fassets%2Fimg%2Fa.png'), {kind: 'static', out: 'pathname:///assets/img/a.png'});
    assert.deepEqual(resolve('../../assets/img/a.png'), {kind: 'static', out: 'pathname:///assets/img/a.png'});
    assert.deepEqual(resolve('../../assets/img/missing.png'), {kind: 'broken', out: 'pathname:///assets/img/missing.png'});
  });

  test('rejects javascript: URLs', () => {
    assert.throws(() => resolve('javascript:alert(1)'));
  });
});

describe('slugs', () => {
  test('mkdocsSlugify matches Python-Markdown 3.2.2 toc.slugify', () => {
    // Expected values were produced with markdown.extensions.toc.slugify(value, '-') in the oracle venv.
    assert.equal(mkdocsSlugify('Consent Management — Overview'), 'consent-management-overview');
    assert.equal(mkdocsSlugify('API (v1.0)  Héllo'), 'api-v10-hello');
    assert.equal(mkdocsSlugify('Configure the <IS_HOME> — server'), 'configure-the-is_home-server');
    assert.equal(mkdocsSlugify('  -- a_b --  '), '-a_b-');
  });

  test('mkdocsUnique appends _1, _2 and increments existing suffixes', () => {
    const seen = new Set();
    assert.equal(mkdocsUnique('step', seen), 'step');
    assert.equal(mkdocsUnique('step', seen), 'step_1');
    assert.equal(mkdocsUnique('step', seen), 'step_2');
    assert.equal(mkdocsUnique('', seen), '_1');
    assert.equal(mkdocsUnique('overview_1', seen), 'overview_1');
    assert.equal(mkdocsUnique('overview_1', seen), 'overview_2');
  });

  test('docusaurusSlug wraps github-slugger 1.5 (with -1 de-duplication)', () => {
    const slugger = new GithubSlugger();
    assert.equal(docusaurusSlug('Step 1: Configure', slugger), 'step-1-configure');
    assert.equal(docusaurusSlug('Step 1: Configure', slugger), 'step-1-configure-1');
    assert.equal(docusaurusSlug('Consent Management — Overview', slugger), 'consent-management--overview');
  });
});

describe('corpus regressions: converting converted output is a no-op', () => {
  const site = siteContext({file: 'install-and-setup/prerequisites.md', nav: {}});

  /**
   * Convert twice and require the second run to change nothing and the result to compile.
   *
   * @param {string} source MkDocs source.
   * @returns {Promise<string>} The converted text.
   */
  async function assertStable(source) {
    const once = convertFile(source, {file: 'install-and-setup/prerequisites.md', site}).text;
    assert.equal(convertFile(once, {file: 'install-and-setup/prerequisites.md', site}).text, once);
    await compile(once, {remarkPlugins: [remarkGfm, remarkDirective]});
    return once;
  }

  test('a table Python-Markdown kept in a paragraph stays inline HTML on a re-run', async () => {
    // As in prerequisites.md: the 3-space table after a list item is a paragraph (`<p><table>`) in
    // MkDocs, but at column 0 it would be a raw HTML block on the next run.
    const once = await assertStable('- If you are using WSO2 API Manager:\n\n   <table>\n      <tr>\n         <th>A `b`</th>\n      </tr>\n</table>\n');
    assert.match(once, /^ <table>$/m);
    assert.match(once, /<th>A `b`<\/th>/);
  });

  test('multi-line inline content in a raw block starts on its own line', async () => {
    // As in the IS catalog: `<span>Possible Values: ⏎ <code>…</code> ⏎ </span>`.
    const once = await assertStable('<div class="x">\n    <span class="v">Possible Values: \n        <code>&quot;a&quot;</code>\n    </span>\n</div>\n');
    assert.match(once, /<span className="v">\n {8}\{"Possible Values:"\}\{" "\}\n {8}<code>"a"<\/code>\n {4}<\/span>/);
  });
});

describe('the converter\'s own JSX forms in MkDocs sources (first run)', () => {
  /**
   * Assert that first-run HTML containing an own JSX form is rejected at `page.md:<line>`.
   *
   * @param {() => unknown} action Conversion.
   * @param {number} line Expected file line.
   */
  function assertRejectedAt(action, line) {
    assert.throws(action, (error) => error instanceof ConversionError && error.message.startsWith(`page.md:${line}:`));
  }

  test('{"x"} inside a source <pre> is rejected with file:line, not rewritten', () => {
    assertRejectedAt(() => htmlToJsx('<pre><code>a = 1\nheaders = {"x"}\n</code></pre>', {file: 'page.md', allowOnclick: false, line: 10}), 11);
  });

  test('{"a"} and {`b`} in table cells are rejected', () => {
    assertRejectedAt(() => htmlToJsx('<table><tr><td>{"a"}</td></tr></table>', {file: 'page.md', allowOnclick: false, line: 3}), 3);
    assertRejectedAt(() => htmlToJsx('<table><tr><td>{`b`}</td></tr></table>', {file: 'page.md', allowOnclick: false, line: 3}), 3);
  });

  test('{/* x */} in a raw HTML block is rejected (it is visible text in MkDocs)', () => {
    const source = 'Intro.\n\n<div>\n  <p>{/* x */}</p>\n</div>\n';
    assertRejectedAt(() => convertFile(source, {file: 'page.md', site: siteContext({file: 'page.md'})}), 4);
  });

  test('style={{…}} in a source tag is rejected, in raw blocks and inline', () => {
    assertRejectedAt(() => htmlToJsx('<div style={{color: "red"}}>a</div>', {file: 'page.md', allowOnclick: false, line: 2}), 2);
    assertRejectedAt(() => convertFile('Text <span style={{color: "red"}}>a</span> end.\n', {file: 'page.md', site: siteContext({file: 'page.md'})}), 1);
  });

  test('converted input is still reversed, so converting twice is stable', () => {
    const once = htmlToJsx('<td>\n  x {y} `z`\n</td>', {file: 'page.md', allowOnclick: false});
    assert.match(once, /\{"x \{y\} `z`"\}/);
    assert.equal(htmlToJsx(once, {file: 'page.md', allowOnclick: false, converted: true}), once);
    assert.throws(() => htmlToJsx(once, {file: 'page.md', allowOnclick: false}), ConversionError);
  });
});
