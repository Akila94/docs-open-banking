/**
 * Tests for parsing the MkDocs `nav:` tree (`parseNav`) and deriving page titles (`navTitles`).
 */
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {parseNav, navTitles} from '../lib/nav-sidebars.mjs';

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
