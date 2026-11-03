/**
 * Tests for the dropdown item helpers: origin resolution, item building and the never-throwing
 * loader (failure, timeout, non-OK and bad-shape paths all leave only "Show all").
 */
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

import {
  SHOW_ALL_ITEM,
  VERSIONS_JSON_PATH,
  buildDropdownItems,
  loadDropdownItems,
  resolveOrigin,
} from './dropdownItems.mjs';

const SITE_URL = 'https://ob.docs.wso2.com';
const LOCAL_ORIGIN = 'http://127.0.0.1:3001';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'versions.json');
const realVersions = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const silentLogger = {warn() {}};

/** A fetch stand-in that records its calls and answers with the given JSON body. */
function jsonFetch(body, {ok = true, status = 200} = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({url, init});
    return {ok, status, json: async () => body};
  };
  return {fetchFn, calls};
}

describe('resolveOrigin', () => {
  test('uses the browser origin when there is one', () => {
    assert.equal(resolveOrigin(LOCAL_ORIGIN, SITE_URL), LOCAL_ORIGIN);
  });

  test('falls back to the configured site URL when there is no window (SSR)', () => {
    assert.equal(resolveOrigin(undefined, SITE_URL), SITE_URL);
    assert.equal(resolveOrigin('', SITE_URL), SITE_URL);
    assert.equal(resolveOrigin('null', SITE_URL), SITE_URL);
  });
});

describe('buildDropdownItems', () => {
  test('"Show all" is root-relative and internal, so it gets no external icon or new tab', () => {
    assert.deepEqual(buildDropdownItems([], LOCAL_ORIGIN), [SHOW_ALL_ITEM]);
    assert.equal(SHOW_ALL_ITEM.href, '/en/versions/');
    assert.equal(SHOW_ALL_ITEM.autoAddBaseUrl, false);
    assert.equal(SHOW_ALL_ITEM.target, '_top');
  });

  test('same-origin entries become root-relative; absolute external ones open in a new tab', () => {
    const items = [
      {label: '4.0.0', href: `${LOCAL_ORIGIN}/en/4.0.0`, external: false},
      {label: '3.0.0', href: 'https://ob.docs.wso2.com/en/3.0.0/', external: true},
    ];
    assert.deepEqual(buildDropdownItems(items, LOCAL_ORIGIN), [
      {label: '4.0.0', href: '/en/4.0.0', autoAddBaseUrl: false, target: '_top'},
      {label: '3.0.0', href: 'https://ob.docs.wso2.com/en/3.0.0/', target: '_blank', rel: 'noopener noreferrer'},
      SHOW_ALL_ITEM,
    ]);
  });

  test('an entry on another origin that is not flagged external is still kept absolute', () => {
    const items = [{label: 'x', href: 'https://other.example/en/x/', external: false}];
    const [entry] = buildDropdownItems(items, LOCAL_ORIGIN);
    assert.equal(entry.href, 'https://other.example/en/x/');
    assert.equal(entry.target, '_blank');
  });
});

describe('loadDropdownItems', () => {
  test('fetches the root-relative versions.json from the given origin, without credentials', async () => {
    const {fetchFn, calls} = jsonFetch(realVersions);
    const items = await loadDropdownItems({fetchFn, origin: LOCAL_ORIGIN, logger: silentLogger});
    assert.equal(calls[0].url, `${LOCAL_ORIGIN}${VERSIONS_JSON_PATH}`);
    assert.equal(VERSIONS_JSON_PATH, '/en/versions/assets/versions.json');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.deepEqual(items.map((item) => item.label), ['4.0.0', '3.0.0', 'Show all']);
    assert.equal(items[0].href, '/en/4.0.0');
  });

  test('a network failure leaves only "Show all" and does not throw', async () => {
    const fetchFn = async () => {
      throw new TypeError('network down');
    };
    assert.deepEqual(await loadDropdownItems({fetchFn, origin: LOCAL_ORIGIN, logger: silentLogger}), [SHOW_ALL_ITEM]);
  });

  test('a non-OK response leaves only "Show all"', async () => {
    const {fetchFn} = jsonFetch(realVersions, {ok: false, status: 503});
    assert.deepEqual(await loadDropdownItems({fetchFn, origin: LOCAL_ORIGIN, logger: silentLogger}), [SHOW_ALL_ITEM]);
  });

  test('a malformed body leaves only "Show all"', async () => {
    const {fetchFn} = jsonFetch({nope: true});
    assert.deepEqual(await loadDropdownItems({fetchFn, origin: LOCAL_ORIGIN, logger: silentLogger}), [SHOW_ALL_ITEM]);
  });

  test('a request that never answers is aborted after the timeout and leaves only "Show all"', async () => {
    const fetchFn = (url, {signal}) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const items = await loadDropdownItems({fetchFn, origin: LOCAL_ORIGIN, timeoutMs: 20, logger: silentLogger});
    assert.deepEqual(items, [SHOW_ALL_ITEM]);
  });

  test('failures are logged as a warning with the reason only', async () => {
    const warnings = [];
    const fetchFn = async () => {
      throw new TypeError('network down');
    };
    await loadDropdownItems({fetchFn, origin: LOCAL_ORIGIN, logger: {warn: (message) => warnings.push(message)}});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /network down/);
  });
});
