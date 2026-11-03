/**
 * Tests for the request handling of scripts/preview-local.mjs: path containment, directory
 * handling, content types and refusals. A real loopback server on an ephemeral port is used, with
 * raw HTTP requests so that clients cannot normalise away `..` or odd encodings.
 *
 * Run with: node --test "scripts/*.test.mjs"
 */
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {createHandler, isContained} from './preview-local.mjs';

let workDir;
let server;
let port;

/** Send a raw request line and resolve with {status, headers, body}. */
function rawRequest(method, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { received += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      const [head, ...bodyParts] = received.split('\r\n\r\n');
      const [statusLine, ...headerLines] = head.split('\r\n');
      const headers = Object.fromEntries(headerLines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
      resolve({status: Number(statusLine.split(' ')[1]), headers, body: bodyParts.join('\r\n\r\n')});
    });
  });
}

before(async () => {
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'preview-test-')));
  const root = path.join(workDir, 'root');
  mkdirSync(path.join(root, 'en', 'latest', 'docs'), {recursive: true});
  writeFileSync(path.join(root, 'en', 'latest', 'index.html'), '<h1>home</h1>');
  writeFileSync(path.join(root, 'en', 'latest', 'docs', 'index.html'), '<h1>docs</h1>');
  writeFileSync(path.join(root, 'en', 'latest', 'data.json'), '{}');
  writeFileSync(path.join(root, 'en', 'latest', 'blob.xyz'), 'x');
  writeFileSync(path.join(workDir, 'secret.txt'), 'secret');
  symlinkSync(path.join(workDir, 'secret.txt'), path.join(root, 'link-out.txt'));
  server = http.createServer(createHandler(root));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, {recursive: true, force: true});
});

test('a directory request with a trailing slash serves its index.html', async () => {
  const response = await rawRequest('GET', '/en/latest/');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.equal(response.body, '<h1>home</h1>');
});

test('a directory request without a trailing slash is redirected to the slash form', async () => {
  const response = await rawRequest('GET', '/en/latest/docs');
  assert.equal(response.status, 301);
  assert.equal(response.headers.location, '/en/latest/docs/');
});

test('a double-slash target cannot produce a protocol-relative redirect', async () => {
  const response = await rawRequest('GET', '//evil.example/en');
  assert.notEqual(response.status, 200);
  if (response.status === 301) assert.match(response.headers.location, /^\/(?!\/)/);
});

test('the query string is ignored when resolving', async () => {
  assert.equal((await rawRequest('GET', '/en/latest/data.json?x=../../secret')).status, 200);
});

test('known extensions get their allow-listed type and unknown ones are opaque', async () => {
  assert.match((await rawRequest('GET', '/en/latest/data.json')).headers['content-type'], /^application\/json/);
  assert.equal((await rawRequest('GET', '/en/latest/blob.xyz')).headers['content-type'], 'application/octet-stream');
});

test('directory traversal, plain or encoded, is refused', async () => {
  for (const target of ['/../secret.txt', '/en/../../secret.txt', '/%2e%2e/secret.txt', '/en/latest/%2e%2e/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
    const {status, body} = await rawRequest('GET', target);
    assert.ok([400, 403, 404].includes(status), `${target} -> ${status}`);
    assert.doesNotMatch(body, /secret$/m, target);
  }
});

test('a symlink that leads outside the root is refused', async () => {
  assert.equal((await rawRequest('GET', '/link-out.txt')).status, 403);
});

test('malformed percent-encoding and NUL bytes are a 400', async () => {
  assert.equal((await rawRequest('GET', '/%E0%A4%A')).status, 400);
  assert.equal((await rawRequest('GET', '/en/latest/%00')).status, 400);
});

test('a target that does not start with a slash is a 400', async () => {
  assert.equal((await rawRequest('GET', 'en/latest/')).status, 400);
});

test('a missing file is a 404 and a directory without index.html is not listed', async () => {
  assert.equal((await rawRequest('GET', '/en/latest/nope.html')).status, 404);
  assert.equal((await rawRequest('GET', '/en/')).status, 404);
});

test('methods other than GET and HEAD are a 405', async () => {
  assert.equal((await rawRequest('POST', '/en/latest/')).status, 405);
  const head = await rawRequest('HEAD', '/en/latest/');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('isContained accepts the root and its children only', () => {
  assert.equal(isContained('/a/b', '/a/b'), true);
  assert.equal(isContained('/a/b', '/a/b/c'), true);
  assert.equal(isContained('/a/b', '/a/bc'), false);
  assert.equal(isContained('/a/b', '/a'), false);
});
