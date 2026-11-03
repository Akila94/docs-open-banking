/**
 * Tests for parsing the MkDocs `nav:` tree (`parseNav`), deriving page titles (`navTitles`) and
 * generating `sidebars.ts` (`buildSidebarsTs`).
 */
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {parseNav, navTitles, buildSidebarsTs, navFiles} from '../lib/nav-sidebars.mjs';

const MKDOCS_YML = `site_name: Sample
theme:
  name: material
nav:
  - 'Home': index.md
  - 'Get Started':
    - 'Open Banking': get-started/open-banking.md
    - 'Quick Start Guide':
      - 'Get Started': get-started/quick-start-guide.md
        # - 'Commented': get-started/commented.md
  - 'Develop':
    - 'Developer Guide': develop/java/developer-guide.md
    - 'Again':
      - 'Developer Guide Twice': develop/java/developer-guide.md
  - '': page-not-found.md

markdown_extensions:
  - pymdownx.emoji:
      emoji_generator: !!python/name:pymdownx.emoji.to_svg
extra:
  site_version: 4.0.0
`;

describe('parseNav', () => {
  test('parses only the nav subtree into NavNodes', () => {
    assert.deepEqual(parseNav(MKDOCS_YML), [
      {label: 'Home', file: 'index.md'},
      {
        label: 'Get Started',
        children: [
          {label: 'Open Banking', file: 'get-started/open-banking.md'},
          {label: 'Quick Start Guide', children: [{label: 'Get Started', file: 'get-started/quick-start-guide.md'}]},
        ],
      },
      {
        label: 'Develop',
        children: [
          {label: 'Developer Guide', file: 'develop/java/developer-guide.md'},
          {label: 'Again', children: [{label: 'Developer Guide Twice', file: 'develop/java/developer-guide.md'}]},
        ],
      },
      {label: '', file: 'page-not-found.md'},
    ]);
  });

  test('tolerates !!python/name tags elsewhere in the document', () => {
    assert.doesNotThrow(() => parseNav(MKDOCS_YML));
  });

  test('tolerates a !!python/name tag inside the nav subtree', () => {
    const yml = "nav:\n  - 'Home': index.md\n  - 'Odd': !!python/name:some.module\n";
    assert.throws(() => parseNav(yml), /Unsupported nav entry/);
  });

  test('throws when there is no nav', () => {
    assert.throws(() => parseNav('site_name: x\n'), /no `nav:`/);
  });
});

describe('navTitles', () => {
  test('maps each file to its first nav label and skips empty labels', () => {
    const titles = navTitles(parseNav(MKDOCS_YML));
    assert.equal(titles.get('index.md'), 'Home');
    assert.equal(titles.get('get-started/quick-start-guide.md'), 'Get Started');
    assert.equal(titles.get('develop/java/developer-guide.md'), 'Developer Guide');
    assert.equal(titles.has('page-not-found.md'), false);
    assert.deepEqual([...titles.keys()], [
      'index.md',
      'get-started/open-banking.md',
      'get-started/quick-start-guide.md',
      'develop/java/developer-guide.md',
    ]);
  });
});

describe('buildSidebarsTs', () => {
  const iconSlugs = {'Get Started': 'get-started', Develop: 'develop'};
  const EXPECTED = `// GENERATED FILE - DO NOT EDIT.
// Generated from the \`nav:\` of the pre-migration en/mkdocs.yml (commit 615f2b8, since deleted)
// by tools/migration. To reproduce, follow the "Converter" section of README.md.
import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Get Started',
      className: 'sidebar-section-icon-get-started',
      collapsed: true,
      items: [
        {type: 'doc', id: 'get-started/open-banking', label: 'Open Banking'},
        {
          type: 'category',
          label: 'Quick Start Guide',
          items: [
            {type: 'doc', id: 'get-started/quick-start-guide', label: 'Get Started'},
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Develop',
      className: 'sidebar-section-icon-develop',
      collapsed: true,
      items: [
        {type: 'doc', id: 'develop/java/developer-guide', label: 'Developer Guide'},
        {
          type: 'category',
          label: 'Again',
          items: [
            {type: 'ref', id: 'develop/java/developer-guide'},
          ],
        },
      ],
    },
  ],
};

export default sidebars;
`;

  test('emits the exact typed sidebar, with a ref for the repeated file and no Home/404 entries', () => {
    assert.equal(buildSidebarsTs(parseNav(MKDOCS_YML), {iconSlugs}), EXPECTED);
  });

  test('is deterministic', () => {
    const nav = parseNav(MKDOCS_YML);
    assert.equal(buildSidebarsTs(nav, {iconSlugs}), buildSidebarsTs(nav, {iconSlugs}));
  });

  test('fails loudly when a top-level category has no icon slug', () => {
    assert.throws(() => buildSidebarsTs(parseNav(MKDOCS_YML), {iconSlugs: {'Get Started': 'get-started'}}), /Develop/);
  });

  test('escapes quotes and backslashes in labels', () => {
    const nav = [{label: 'Get Started', children: [{label: "It's a \\ path", file: 'a.md'}]}];
    assert.match(buildSidebarsTs(nav, {iconSlugs}), /label: 'It\\'s a \\\\ path'/);
  });
});

describe('navFiles', () => {
  test('lists every nav file including the 404 page', () => {
    assert.deepEqual([...navFiles(parseNav(MKDOCS_YML))].sort(), [
      'develop/java/developer-guide.md', 'get-started/open-banking.md', 'get-started/quick-start-guide.md',
      'index.md', 'page-not-found.md',
    ]);
  });
});
