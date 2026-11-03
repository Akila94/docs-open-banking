import {test} from 'node:test';
import assert from 'node:assert/strict';

import rehypeReplaceUnparsableLinks, {isParsableHref} from './llms-txt-unparsable-links.mjs';

/** A minimal hast anchor. */
function anchor(href, text) {
  return {type: 'element', tagName: 'a', properties: {href}, children: [{type: 'text', value: text}]};
}

/** Run the plugin over `<p>children</p>` and return the paragraph's resulting children. */
function run(...children) {
  const tree = {type: 'root', children: [{type: 'element', tagName: 'p', properties: {}, children}]};
  rehypeReplaceUnparsableLinks()(tree);
  return tree.children[0].children;
}

test('isParsableHref accepts absolute, relative, root-relative and fragment links', () => {
  for (const href of ['https://example.com/a', '/en/latest/x/', '../a/b.md', '#frag', 'mailto:a@b.c', 'pathname:///assets/img/a.png']) {
    assert.equal(isParsableHref(href), true, href);
  }
});

test('isParsableHref rejects placeholder hosts that new URL cannot parse', () => {
  assert.equal(isParsableHref('https://<APIM_HOST>:9443/devportal'), false);
  assert.equal(isParsableHref('http://[::1'), false);
});

test('an unparsable link becomes its text followed by the literal URL in a code span', () => {
  const result = run(anchor('https://<APIM_HOST>:9443/devportal', 'Developer portal'));
  assert.deepEqual(result, [
    {type: 'text', value: 'Developer portal'},
    {type: 'text', value: ' ('},
    {type: 'element', tagName: 'code', properties: {}, children: [{type: 'text', value: 'https://<APIM_HOST>:9443/devportal'}]},
    {type: 'text', value: ')'},
  ]);
});

test('parsable links and other elements are left untouched', () => {
  const link = anchor('https://example.com/', 'ok');
  assert.deepEqual(run(link, {type: 'text', value: ' tail'}), [link, {type: 'text', value: ' tail'}]);
});

test('links without an href string are left untouched', () => {
  const bare = {type: 'element', tagName: 'a', properties: {}, children: [{type: 'text', value: 'x'}]};
  assert.deepEqual(run(bare), [bare]);
});

test('nested unparsable links are replaced at any depth', () => {
  const inner = {type: 'element', tagName: 'strong', properties: {}, children: [anchor('https://<X>/', 'deep')]};
  const [strong] = run(inner);
  assert.equal(strong.children[0].value, 'deep');
  assert.equal(strong.children.length, 4);
});
