import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {assertRegularSourceFile, findLinkedImagePaths, resolveLinkedImage, LINKED_IMAGE_URL_PREFIX} from './copy-linked-images-core.mjs';

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

describe('assertRegularSourceFile', () => {
  /** A temp image root with `real.png`, a symlinked file, and a symlinked directory. */
  function makeRoot() {
    const outside = mkdtempSync(path.join(tmpdir(), 'cli-outside-'));
    writeFileSync(path.join(outside, 'secret.png'), 'secret');
    const root = mkdtempSync(path.join(tmpdir(), 'cli-root-'));
    mkdirSync(path.join(root, 'dir'));
    writeFileSync(path.join(root, 'dir', 'real.png'), 'png');
    symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'link.png'));
    symlinkSync(outside, path.join(root, 'linkdir'));
    return {root, cleanup: () => { rmSync(root, {recursive: true}); rmSync(outside, {recursive: true}); }};
  }

  test('accepts a regular file', () => {
    const {root, cleanup} = makeRoot();
    try {
      assert.doesNotThrow(() => assertRegularSourceFile('dir/real.png', root));
    } finally {
      cleanup();
    }
  });

  test('rejects a symlinked file, a file under a symlinked directory, a directory and a missing file', () => {
    const {root, cleanup} = makeRoot();
    try {
      assert.throws(() => assertRegularSourceFile('link.png', root), /symbolic link/);
      assert.throws(() => assertRegularSourceFile('linkdir/secret.png', root), /symbolic link/);
      assert.throws(() => assertRegularSourceFile('dir', root), /not a regular file/);
      assert.throws(() => assertRegularSourceFile('dir/none.png', root), /does not exist/);
    } finally {
      cleanup();
    }
  });
});
