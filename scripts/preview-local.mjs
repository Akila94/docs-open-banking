#!/usr/bin/env node
/**
 * Production-like local preview.
 *
 * Builds the site with BASE_URL=/en/latest/, stages it under `.preview/en/latest/` next to a copy
 * of the published `versions.json` (`.preview/en/versions/assets/versions.json`, which the version
 * dropdown fetches from the same origin), and serves `.preview/` on http://127.0.0.1:3001/.
 *
 *   npm run preview                 build, stage and serve
 *   npm run preview -- --no-build   re-serve the existing build/ without rebuilding
 *
 * `versions.json` is read from the `upstream/versions` branch (`git fetch upstream versions` first).
 * Only Node built-ins are used. The server binds to the loopback interface only, serves GET/HEAD
 * of regular files below `.preview/`, never lists directories, and rejects any path that resolves
 * (after decoding, normalising and following symlinks) outside that root.
 */
import {execFile, spawn} from 'node:child_process';
import {createReadStream, existsSync} from 'node:fs';
import {cp, mkdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {pipeline} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const HOST = '127.0.0.1';
const PORT = 3001;
const BASE_URL = '/en/latest/';
const VERSIONS_GIT_SPEC = 'upstream/versions:en/docs/assets/versions.json';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(REPO_ROOT, 'build');
const PREVIEW_ROOT = path.join(REPO_ROOT, '.preview');
const DOCUSAURUS_BIN = path.join(REPO_ROOT, 'node_modules', '@docusaurus', 'core', 'bin', 'docusaurus.mjs');
const MAX_VERSIONS_JSON_BYTES = 1024 * 1024;

/** Content types served by extension. Anything else is sent as an opaque download. */
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
});
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/** Raised for problems the user can fix (missing build, missing git ref); printed without a stack. */
class PreviewError extends Error {}

/**
 * Build the site for the preview base URL by running Docusaurus with this Node binary.
 *
 * @returns {Promise<void>} Resolves when the build succeeds.
 * @throws {PreviewError} When Docusaurus is not installed or the build fails.
 */
function buildSite() {
  if (!existsSync(DOCUSAURUS_BIN)) {
    throw new PreviewError('Docusaurus is not installed; run `npm ci` first.');
  }
  console.log(`preview: building with BASE_URL=${BASE_URL}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DOCUSAURUS_BIN, 'build'], {
      cwd: REPO_ROOT,
      env: {...process.env, BASE_URL},
      stdio: 'inherit',
    });
    child.on('error', (error) => reject(new PreviewError(`could not start the build: ${error.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new PreviewError(`the build failed (exit code ${code})`))));
  });
}

/**
 * Read the published versions list from the `versions` branch of the `upstream` remote.
 * The git arguments are a fixed array (no shell is involved).
 *
 * @returns {Promise<string>} The validated JSON text.
 * @throws {PreviewError} When git cannot read the file or its content is not JSON.
 */
async function readVersionsJson() {
  let stdout;
  try {
    ({stdout} = await execFileAsync('git', ['show', VERSIONS_GIT_SPEC], {cwd: REPO_ROOT, maxBuffer: MAX_VERSIONS_JSON_BYTES}));
  } catch (error) {
    throw new PreviewError(
      `could not read ${VERSIONS_GIT_SPEC} (${String(error.stderr || error.message).trim()}). `
      + 'Add the remote and fetch the branch: `git remote add upstream https://github.com/wso2/docs-open-banking.git` '
      + 'and `git fetch upstream versions`.',
    );
  }
  try {
    JSON.parse(stdout);
  } catch {
    throw new PreviewError(`${VERSIONS_GIT_SPEC} is not valid JSON.`);
  }
  return stdout;
}

/**
 * Recreate `.preview/` from the current `build/` and the versions list.
 *
 * @returns {Promise<void>} Resolves when staging is complete.
 * @throws {PreviewError} When `build/` is missing or versions.json is unavailable.
 */
async function stagePreview() {
  if (!existsSync(path.join(BUILD_DIR, 'index.html'))) {
    throw new PreviewError('build/ is missing; run `npm run preview` without --no-build first.');
  }
  const versionsJson = await readVersionsJson();
  await rm(PREVIEW_ROOT, {recursive: true, force: true});
  await cp(BUILD_DIR, path.join(PREVIEW_ROOT, 'en', 'latest'), {recursive: true});
  const versionsDir = path.join(PREVIEW_ROOT, 'en', 'versions', 'assets');
  await mkdir(versionsDir, {recursive: true});
  await writeFile(path.join(versionsDir, 'versions.json'), versionsJson);
  console.log(`preview: staged ${path.relative(REPO_ROOT, PREVIEW_ROOT)}/`);
}

/**
 * Whether a resolved path is the root or lies inside it.
 *
 * @param {string} root Absolute root directory.
 * @param {string} candidate Absolute path to test.
 * @returns {boolean} True when `candidate` cannot escape `root`.
 */
export function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Map a request target to a path below the root, or explain why it is refused.
 *
 * @param {string} rootDir Absolute (real) root directory.
 * @param {string} requestTarget The raw request target, e.g. `/en/latest/a/?x=1`.
 * @returns {{status: 400 | 403} | {absolutePath: string, endsWithSlash: boolean}} A refusal or the lexical path.
 */
export function resolveRequestPath(rootDir, requestTarget) {
  const rawPath = requestTarget.split(/[?#]/, 1)[0];
  if (!rawPath.startsWith('/')) return {status: 400};
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return {status: 400};
  }
  if (decoded.includes('\0')) return {status: 400};
  const normalized = path.normalize(decoded);
  const absolutePath = path.resolve(rootDir, `.${path.sep}${normalized}`);
  if (!isContained(rootDir, absolutePath)) return {status: 403};
  return {absolutePath, endsWithSlash: decoded.endsWith('/')};
}

/** Send a short plain-text response. */
function sendText(response, status, message, extraHeaders = {}) {
  response.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extraHeaders});
  response.end(`${message}\n`);
}

/**
 * Create the request handler for a given root.
 *
 * @param {string} rootDir Absolute real path of the directory to serve.
 * @returns {(request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>} The handler.
 */
export function createHandler(rootDir) {
  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method Not Allowed', {Allow: 'GET, HEAD'});
      return;
    }
    const resolved = resolveRequestPath(rootDir, request.url ?? '');
    if ('status' in resolved) {
      sendText(response, resolved.status, resolved.status === 400 ? 'Bad Request' : 'Forbidden');
      return;
    }
    try {
      let target = await realpath(resolved.absolutePath);
      // A symlink inside the root must not lead out of it.
      if (!isContained(rootDir, target)) {
        sendText(response, 403, 'Forbidden');
        return;
      }
      if ((await stat(target)).isDirectory()) {
        if (!resolved.endsWithSlash) {
          const relative = path.relative(rootDir, resolved.absolutePath).split(path.sep).map(encodeURIComponent).join('/');
          sendText(response, 301, 'Moved Permanently', {Location: `/${relative}/`});
          return;
        }
        target = path.join(target, 'index.html');
        if (!(await stat(target)).isFile()) throw Object.assign(new Error('not a file'), {code: 'ENOENT'});
      }
      await sendFile(request, response, target);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        sendText(response, 404, 'Not Found');
        return;
      }
      console.error(`preview: request failed: ${error.code ?? error.message}`);
      if (!response.headersSent) sendText(response, 500, 'Internal Server Error');
      else response.destroy();
    }
  };
}

/** Stream one regular file with a content type from the allow-list map. */
async function sendFile(request, response, filePath) {
  const fileStat = await stat(filePath);
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? FALLBACK_CONTENT_TYPE,
    'Content-Length': fileStat.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  pipeline(createReadStream(filePath), response, (error) => {
    if (error) response.destroy();
  });
}

/**
 * Serve the staged preview until the process is stopped.
 *
 * @returns {Promise<void>} Never resolves while the server is up; rejects if it cannot listen.
 */
async function serve() {
  const rootDir = await realpath(PREVIEW_ROOT);
  const server = http.createServer(createHandler(rootDir));
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new PreviewError(
      error.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : `cannot listen on ${HOST}:${PORT}: ${error.message}`,
    )));
    server.listen(PORT, HOST, resolve);
  });
  console.log(`preview: serving http://${HOST}:${PORT}${BASE_URL} (Ctrl-C to stop)`);
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/** Entry point: parse flags, build (unless --no-build), stage and serve. */
async function main(argv) {
  const unknown = argv.filter((argument) => argument !== '--no-build');
  if (unknown.length > 0) throw new PreviewError(`unknown argument(s): ${unknown.join(' ')} (supported: --no-build)`);
  if (!argv.includes('--no-build')) await buildSite();
  await stagePreview();
  await serve();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`preview: ${error instanceof PreviewError ? error.message : error.stack}`);
    process.exitCode = 1;
  });
}
