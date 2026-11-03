/**
 * Tests for parseVersions, using the real versions.json published on the `versions` branch.
 * Run with: node --test src/theme/NavbarItem/ObVersionDropdown/
 */
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {parseVersions} from './parseVersions.mjs';

const ORIGIN = 'https://ob.docs.wso2.com';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'versions.json');
const realVersions = JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('parseVersions', () => {
  test('lists the versions in `list` order, marking absolute docs URLs as external', () => {
    assert.deepEqual(parseVersions(realVersions, ORIGIN), {
      items: [
        {label: '4.0.0', href: 'https://ob.docs.wso2.com/en/4.0.0', external: false},
        {label: '3.0.0', href: 'https://ob.docs.wso2.com/en/3.0.0/', external: true},
      ],
    });
  });

  test('drops entries whose doc is not http(s)', () => {
    const hostile = {
      list: ['1.0.0', '2.0.0', '3.0.0', '4.0.0'],
      all: {
        '1.0.0': {doc: 'javascript:alert(1)'},
        '2.0.0': {doc: 'data:text/html,x'},
        '3.0.0': {doc: 'https://example.com/3.0.0/'},
        '4.0.0': {doc: '4.0.0'},
      },
    };
    assert.deepEqual(parseVersions(hostile, ORIGIN).items.map((item) => item.label), ['3.0.0', '4.0.0']);
  });

  test('skips list keys that have no entry or no string doc', () => {
    const sparse = {list: ['9.9.9', '8.8.8'], all: {'8.8.8': {doc: 42}}};
    assert.deepEqual(parseVersions(sparse, ORIGIN), {items: []});
  });

  test('throws TypeError on a bad shape', () => {
    for (const bad of [null, undefined, 'x', 7, [], {}, {list: 'x'}, {list: [], all: null}, {list: [1], all: {}}]) {
      assert.throws(() => parseVersions(bad, ORIGIN), TypeError, `expected TypeError for ${JSON.stringify(bad)}`);
    }
  });
});
