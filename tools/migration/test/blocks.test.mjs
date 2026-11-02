/**
 * Fixture-driven tests for the block-level conversion (MkDocs dialect -> CommonMark/MDX).
 *
 * Every directory under `test/fixtures/` holds an `input.md` (MkDocs source), a hand-written
 * `expected.md` and an optional `ctx.json` (`{"file": "<docs-relative path>"}`). For each one:
 * the converted input must equal `expected.md`, `expected.md` must compile as MDX, and
 * converting `expected.md` again must not change it (idempotency). A fixture with
 * `expected-error.txt` instead (`<file>:<line>`) must fail with a ConversionError at that location.
 */
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {compile, createProcessor} from '@mdx-js/mdx';
import remarkDirective from 'remark-directive';
import remarkGfm from 'remark-gfm';

import {convertFile} from '../lib/pipeline.mjs';
import {convertBlocks} from '../lib/pymd-blocks.mjs';
import {splitFrontMatter, joinFrontMatter, mapTemplate} from '../lib/frontmatter.mjs';
import {applyFixups, applyFixupsWithLines, FixupError} from '../lib/fixups.mjs';
import {ConversionError} from '../lib/errors.mjs';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Load every fixture case in a stable (sorted) order.
 *
 * @returns {Array<{name: string, input: string, expected: string|null, errorLocation: string|null, file: string}>}
 */
function loadFixtures() {
  return readdirSync(FIXTURES_DIR, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = path.join(FIXTURES_DIR, name);
      const ctxPath = path.join(dir, 'ctx.json');
      const ctx = existsSync(ctxPath) ? JSON.parse(readFileSync(ctxPath, 'utf8')) : {};
      const read = (file) => (existsSync(path.join(dir, file)) ? readFileSync(path.join(dir, file), 'utf8') : null);
      return {
        name,
        input: read('input.md'),
        expected: read('expected.md'),
        errorLocation: read('expected-error.txt')?.trim() ?? null,
        file: ctx.file ?? `${name}.md`,
      };
    });
}

/**
 * Compile MDX the way the converter's acceptance check does (directives + GFM).
 *
 * @param {string} source MDX source.
 * @returns {Promise<void>} Rejects with the MDX compile error.
 */
async function compileMdx(source) {
  await compile(source, {remarkPlugins: [remarkGfm, remarkDirective]});
}

/**
 * Assert that `action` throws a ConversionError whose message starts with `${location}:`.
 *
 * @param {() => unknown} action Code under test.
 * @param {string} location Expected `file:line`.
 */
function assertFailsAt(action, location) {
  assert.throws(action, (error) => error instanceof ConversionError && error.message.startsWith(`${location}:`));
}

const fixtures = loadFixtures();

describe('block conversion fixtures', () => {
  test('fixture set is not empty', () => {
    assert.ok(fixtures.length >= 15, `expected at least 15 fixtures, found ${fixtures.length}`);
  });

  for (const fixture of fixtures.filter((entry) => entry.errorLocation !== null)) {
    test(`${fixture.name}: fails with a ConversionError at ${fixture.errorLocation}`, () => {
      assertFailsAt(() => convertFile(fixture.input, {file: fixture.file}), fixture.errorLocation);
    });
  }

  for (const fixture of fixtures.filter((entry) => entry.errorLocation === null)) {
    test(`${fixture.name}: converts to expected.md`, () => {
      assert.equal(convertFile(fixture.input, {file: fixture.file}).text, fixture.expected);
    });

    test(`${fixture.name}: expected.md compiles as MDX`, async () => {
      await compileMdx(fixture.expected);
    });

    test(`${fixture.name}: convertBlocks(expected) is unchanged (idempotent)`, () => {
      const {body} = splitFrontMatter(fixture.expected);
      assert.equal(convertBlocks(body, {file: fixture.file}).text, body);
      assert.equal(convertFile(fixture.expected, {file: fixture.file}).text, fixture.expected);
    });
  }
});

/**
 * Parse MDX into an mdast tree without positions (for structural comparison).
 *
 * @param {string} source MDX source.
 * @returns {object} mdast root.
 */
function mdxTree(source) {
  const tree = createProcessor({remarkPlugins: [remarkGfm, remarkDirective]}).parse(source);
  return JSON.parse(JSON.stringify(tree, (key, value) => (key === 'position' ? undefined : value)));
}

describe('4-space list children render like CommonMark content columns', () => {
  const dir = path.join(FIXTURES_DIR, 'list-ten-plus');
  const fourSpace = readFileSync(path.join(dir, 'expected.md'), 'utf8');
  const contentColumn = readFileSync(path.join(dir, 'content-column.md'), 'utf8');

  test('both layouts compile', async () => {
    await compileMdx(fourSpace);
    await compileMdx(contentColumn);
  });

  test('both layouts produce the same MDX tree', () => {
    assert.deepEqual(mdxTree(fourSpace), mdxTree(contentColumn));
  });

  test('item 10 keeps its nested list, admonition and Tabs inside its <li>', () => {
    const list = mdxTree(fourSpace).children.find((node) => node.type === 'list');
    assert.equal(list.children.length, 11);
    const itemTen = list.children[9];
    assert.deepEqual(
      itemTen.children.map((node) => (node.type === 'containerDirective' ? `directive:${node.name}` : node.name ?? node.type)),
      ['paragraph', 'list', 'directive:tip', 'Tabs'],
    );
    assert.equal(itemTen.children[1].children[0].children[1].type, 'containerDirective');
    assert.equal(list.children[8].children[1].name, 'note');
  });
});

describe('convertBlocks imports', () => {
  test('reports Tabs only when a tab group is emitted', () => {
    const withTabs = convertBlocks('```bash tab="A"\nx\n```\n', {file: 'a.md'});
    assert.deepEqual([...withTabs.imports], ['Tabs']);
    const withoutTabs = convertBlocks('```bash\nx\n```\n', {file: 'a.md'});
    assert.equal(withoutTabs.imports.size, 0);
  });

  test('reports DeprecatedBanner for the snippet', () => {
    const result = convertBlocks('--8<-- "deprecated-banner.md"\n\nText.\n', {file: 'develop/java/x.md'});
    assert.deepEqual([...result.imports], ['DeprecatedBanner']);
  });
});

describe('convertBlocks fails loudly', () => {
  /**
   * Assert that converting `source` throws a ConversionError that names `file:line`.
   *
   * @param {string} source Markdown body.
   * @param {string} location Expected `file:line` prefix.
   */
  function assertConversionError(source, location) {
    assert.throws(
      () => convertBlocks(source, {file: 'page.md'}),
      (error) => error instanceof ConversionError && error.message.startsWith(location),
    );
  }

  test('on an admonition marker that renders as literal text', () => {
    assertConversionError('Intro.\n\n!!!note Event hub configuration is used.\n', 'page.md:3');
  });

  test('on a tab= fence that never opens', () => {
    assertConversionError('Intro.\n\n```bash tab="A" extra words\nx\n', 'page.md:3');
  });

  test('on an unknown snippet', () => {
    assertConversionError('--8<-- "other.md"\n', 'page.md:1');
  });

  test('on text that Python-Markdown drops before an admonition marker', () => {
    assertConversionError('Lost line\n!!! note\n    Body.\n', 'page.md:1');
  });

  test('on an unknown admonition type', () => {
    assertConversionError('!!! danger\n    Body.\n', 'page.md:1');
  });
});

describe('nested-list rule keeps code text exact', () => {
  const source = readFileSync(path.join(FIXTURES_DIR, 'nested-list-code-shift', 'input.md'), 'utf8');

  test('is accepted when a fixup produced the shifted code lines (compensation)', () => {
    const {text} = convertFile(source, {file: 'page.md', fixupLines: new Set([4])});
    assert.match(text, /^ {8}```$/m);
  });

  test('fails at the code line when no fixup compensates', () => {
    assertFailsAt(() => convertFile(source, {file: 'page.md', fixupLines: new Set([1])}), 'page.md:4');
  });
});

describe('front matter errors are located', () => {
  test('an unknown template names the file and the template line', () => {
    assertFailsAt(() => convertFile('---\ntemplate: templates/other.html\n---\nBody\n', {file: 'page.md'}), 'page.md:2');
  });

  test('malformed YAML names the file and the line js-yaml reports', () => {
    assertFailsAt(() => convertFile('---\ntitle: ok\ntemplate: [unclosed\n---\nBody\n', {file: 'page.md'}), 'page.md:4');
  });
});

describe('front matter', () => {
  test('splitFrontMatter tolerates trailing spaces after the fences', () => {
    const {data, body} = splitFrontMatter('--- \ntemplate: templates/redoc.html \n---\n\nBody\n');
    assert.deepEqual(data, {template: 'templates/redoc.html'});
    assert.equal(body, '\nBody\n');
  });

  test('splitFrontMatter returns null data without front matter', () => {
    assert.deepEqual(splitFrontMatter('# Title\n'), {data: null, body: '# Title\n'});
  });

  test('mapTemplate maps single-column and redoc', () => {
    assert.deepEqual(mapTemplate({template: 'templates/single-column.html'}), {
      displayed_sidebar: null,
      hide_table_of_contents: true,
      hide_markdown_actions: true,
    });
    assert.deepEqual(mapTemplate({template: 'templates/redoc.html'}), {
      wide: true,
      hide_markdown_actions: true,
    });
    assert.deepEqual(mapTemplate({title: 'Kept'}), {title: 'Kept'});
  });

  test('mapTemplate rejects unknown templates', () => {
    assert.throws(() => mapTemplate({template: 'templates/other.html'}), /Unknown MkDocs template/);
  });

  test('joinFrontMatter writes keys in a stable order with JSON-quoted strings', () => {
    const text = joinFrontMatter({wide: true, zeta: 'z', title: 'A "quoted" title', hide_markdown_actions: true}, 'Body\n');
    assert.equal(
      text,
      '---\ntitle: "A \\"quoted\\" title"\nhide_markdown_actions: true\nwide: true\nzeta: "z"\n---\nBody\n',
    );
    assert.equal(joinFrontMatter(null, 'Body\n'), 'Body\n');
  });
});

describe('applyFixups', () => {
  const fixup = (overrides = {}) => ({
    id: 'sample-fixup',
    file: 'a.md',
    find: 'needle',
    replace: 'pin',
    reason: 'a.md:1 test fixup',
    ...overrides,
  });

  test('replaces a unique match without mutating the input map', () => {
    const files = new Map([['a.md', 'hay needle hay']]);
    const result = applyFixups(files, [fixup()]);
    assert.equal(result.get('a.md'), 'hay pin hay');
    assert.equal(files.get('a.md'), 'hay needle hay');
  });

  test('throws FixupError naming the id when find matches 0 times', () => {
    const files = new Map([['a.md', 'hay hay']]);
    assert.throws(() => applyFixups(files, [fixup()]), (error) => error instanceof FixupError && /sample-fixup/.test(error.message));
  });

  test('throws FixupError naming the id when find matches 2 times', () => {
    const files = new Map([['a.md', 'needle needle']]);
    assert.throws(() => applyFixups(files, [fixup()]), (error) => error instanceof FixupError && /sample-fixup/.test(error.message));
  });

  test('throws FixupError for a missing file, a bad id or an escaping path', () => {
    const files = new Map([['a.md', 'needle']]);
    assert.throws(() => applyFixups(files, [fixup({file: 'missing.md'})]), FixupError);
    assert.throws(() => applyFixups(files, [fixup({id: 'Bad Id'})]), FixupError);
    assert.throws(() => applyFixups(files, [fixup({file: '../a.md'})]), FixupError);
    assert.throws(() => applyFixups(files, [fixup({reason: ''})]), FixupError);
  });

  test('applyFixupsWithLines reports the fixed-file lines each replace produced', () => {
    const files = new Map([['a.md', 'one\ntwo\nneedle\nfour\nother\n']]);
    const {files: fixed, fixupLines} = applyFixupsWithLines(files, [
      fixup({id: 'grow', find: 'two\n', replace: 'two\n2b\n'}),
      fixup({id: 'later', find: 'other', replace: 'x\ny'}),
      fixup({id: 'earlier', find: 'needle', replace: 'pin'}),
    ]);
    assert.equal(fixed.get('a.md'), 'one\ntwo\n2b\npin\nfour\nx\ny\n');
    assert.deepEqual([...fixupLines.get('a.md')].sort((a, b) => a - b), [2, 3, 4, 6, 7]);
  });

  test('throws FixupError on duplicate ids', () => {
    const files = new Map([['a.md', 'needle other']]);
    assert.throws(
      () => applyFixups(files, [fixup(), fixup({find: 'other'})]),
      (error) => error instanceof FixupError && /duplicate/.test(error.message),
    );
  });
});
