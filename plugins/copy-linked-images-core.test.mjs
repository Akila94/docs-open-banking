import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {findLinkedImagePaths, resolveLinkedImage, LINKED_IMAGE_URL_PREFIX} from './copy-linked-images-core.mjs';

const BASE = '/en/latest/';

test('selects only hrefs under <baseUrl>assets/img/, decoded, without query or fragment', () => {
  const html = `
    <a href="/en/latest/assets/img/a/b.png">x</a>
    <a href='/en/latest/assets/img/c%20d.png#frag'>y</a>
    <a href="/en/latest/assets/img/e.png?v=1">z</a>
    <a href="/en/latest/assets/images/not-this.png">n</a>
    <a href="/en/latest/learn/page/">n</a>
    <img src="/en/latest/assets/img/ignored-src.png">
    <a href="/en/4.0.0/assets/img/other-base.png">n</a>`;
  assert.deepEqual([...findLinkedImagePaths(html, BASE)].sort(), ['a/b.png', 'c d.png', 'e.png']);
});

test('uses the prefix constant', () => {
  assert.equal(LINKED_IMAGE_URL_PREFIX, 'assets/img/');
});

test('resolves a valid relative path inside the source root', () => {
  const root = path.resolve('/site/en/docs/assets/img');
  assert.equal(resolveLinkedImage('a/b.png', root), path.join(root, 'a', 'b.png'));
});

test('rejects traversal, absolute, backslash, NUL and empty paths', () => {
  const root = path.resolve('/site/en/docs/assets/img');
  for (const bad of ['../x.png', 'a/../../x.png', '/etc/passwd', 'a\\..\\x.png', 'a\0b.png', '', '.', 'a/./b.png', 'a//b.png', 'a/']) {
    assert.throws(() => resolveLinkedImage(bad, root), /linked image path/, JSON.stringify(bad));
  }
});
