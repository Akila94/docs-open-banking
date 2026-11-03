/**
 * MkDocs-faithful link and image resolution (spec §3 pass 11, §5).
 *
 * MkDocs 1.1.2 (`_RelativePathTreeprocessor.path_to_url`) rewrites a Markdown link only when it is
 * relative, has a `.` in its last path segment and its percent-decoded, file-relative target
 * exists in the docs; otherwise the href is emitted as written and the browser resolves it
 * against the page URL (`use_directory_urls`: `a/b.md` is served at `a/b/`).
 *
 * `resolveMkdocsLink` works out that final URL and returns the Docusaurus form that reaches the same
 * URL at the same page URL:
 *   doc      -> file-relative `.md` (+ query/anchor); Docusaurus maps it to the permalink
 *   static   -> `pathname:///<path>` (attachments, specs and the Redoc bundle live in `static/`)
 *   image    -> file-relative path to an existing asset (bundled by webpack)
 *   external -> unchanged (any scheme or `//`), anchor -> unchanged
 *   broken   -> the same final URL: `pathname:///<base-relative path>` (Docusaurus would otherwise add
 *               a trailing slash), an absolute URL when it leaves the base, the original src for
 *               images (Docusaurus leaves broken image URLs as written)
 */
import {statSync} from 'node:fs';
import path from 'node:path';

/** Docs-relative prefixes that Task 5 moves to `static/` at the same relative paths. */
export const STATIC_PREFIXES = Object.freeze(['assets/attachments/', 'internal-apis/', 'assets/lib/redoc/']);

/** Schemes that must never reach a link (after removing whitespace and control characters). */
const UNSAFE_SCHEME = /^(?:javascript|vbscript|data):/i;
/** RFC 3986 scheme, or a protocol-relative URL (same test as Docusaurus `hasProtocol`). */
const HAS_PROTOCOL = /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/;
/** Characters Python's `urllib.parse.quote(path)` leaves alone (safe='/'). */
const PY_QUOTE_SAFE = /[A-Za-z0-9_.~/-]/;

/**
 * Throw when a URL would execute script once rendered.
 *
 * @param {string} url Decoded URL (attribute value or Markdown destination).
 * @throws {Error} For `javascript:`, `vbscript:` and `data:` URLs.
 */
export function assertSafeUrl(url) {
  const normalized = String(url).replace(/[\u0000- \u007f]+/g, '');
  if (UNSAFE_SCHEME.test(normalized)) {
    throw new Error(`refusing an unsafe URL scheme in ${JSON.stringify(normalized.slice(0, 40))}`);
  }
}

/**
 * Whether a docs-relative path is a static asset after the Task 5 move.
 *
 * @param {string} relative Docs-relative POSIX path.
 * @returns {boolean} True for attachments, specs and the Redoc bundle.
 */
export function isStaticPath(relative) {
  return STATIC_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

/**
 * Whether a link (not an image src) targets an image file. Docusaurus would bundle such a link to
 * `assets/files/<hash>.<ext>/` (a 404 with trailingSlash), so it is emitted as `pathname:///assets/img/...`,
 * MkDocs's own URL; `plugins/copy-linked-images.ts` publishes the linked files there.
 *
 * @param {string} relative Docs-relative target.
 * @param {boolean} image True when the reference is an image src.
 * @returns {boolean} True for links to files under `assets/img/`.
 */
function isLinkedImage(relative, image) {
  return !image && relative.startsWith('assets/img/');
}

/**
 * Port of Python's `urllib.parse.unquote` (UTF-8, invalid sequences replaced).
 *
 * @param {string} value Percent-encoded text.
 * @returns {string} Decoded text.
 */
export function pythonUnquote(value) {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => Buffer.from(run.replaceAll('%', ''), 'hex').toString('utf8'));
}

/**
 * Port of Python's `urllib.parse.quote(path)` (safe='/'), which MkDocs uses for file URLs.
 *
 * @param {string} value Decoded path.
 * @returns {string} Percent-encoded path.
 */
export function pythonQuote(value) {
  let out = '';
  for (const char of value) {
    out += PY_QUOTE_SAFE.test(char)
      ? char
      : [...Buffer.from(char, 'utf8')].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }
  return out;
}

/**
 * Build the existence check used by the resolver. Mirrors MkDocs's file collection (no dotfiles,
 * no root `templates/`), never looks outside the docs (or static) directory, and also answers for
 * static assets that Task 5 has already moved to `<repoRoot>/static/<path>`.
 *
 * @param {string} docsDir Absolute docs directory (`<repoRoot>/en/docs`).
 * @returns {(relative: string) => boolean} True when the docs-relative file exists.
 */
export function createExistsFn(docsDir) {
  const docsRoot = path.resolve(docsDir);
  const staticRoot = path.join(path.dirname(path.dirname(docsRoot)), 'static');
  const isFile = (absolute) => {
    try {
      return statSync(absolute).isFile();
    } catch {
      return false;
    }
  };
  return (relative) => {
    if (!isContainedPath(relative) || relative.startsWith('templates/')) {
      return false;
    }
    return isFile(path.join(docsRoot, ...relative.split('/')))
      || (isStaticPath(relative) && isFile(path.join(staticRoot, ...relative.split('/'))));
  };
}

/**
 * A normalised docs-relative path that stays inside the docs root and has no hidden segment.
 *
 * @param {string} relative POSIX path.
 * @returns {boolean} True when safe to look up.
 */
function isContainedPath(relative) {
  if (relative === '' || relative.startsWith('/') || relative.includes('\0')) {
    return false;
  }
  return relative.split('/').every((segment) => segment !== '' && segment !== '..' && !segment.startsWith('.'));
}

/**
 * The page URL MkDocs gives a Markdown file (relative to the site root, `use_directory_urls`).
 *
 * @param {string} file Docs-relative `.md` path.
 * @returns {string} '' for the home page, otherwise a path ending in `/`.
 */
export function mkdocsPageUrl(file) {
  const stem = file.replace(/\.md$/, '');
  if (stem === 'index') {
    return '';
  }
  return stem.endsWith('/index') ? stem.slice(0, -'index'.length) : `${stem}/`;
}

/**
 * Split an href into its path and its `?query#fragment` suffix.
 *
 * @param {string} href Link destination.
 * @returns {{pathPart: string, suffix: string}} Parts.
 */
function splitHref(href) {
  const index = href.search(/[?#]/);
  return index === -1 ? {pathPart: href, suffix: ''} : {pathPart: href.slice(0, index), suffix: href.slice(index)};
}

/**
 * File-relative path from one docs file to another.
 *
 * @param {string} fromFile Docs-relative source file.
 * @param {string} target Docs-relative target.
 * @returns {string} POSIX relative path.
 */
function relativeFrom(fromFile, target) {
  return path.posix.relative(path.posix.dirname(fromFile), target);
}

/**
 * The doc MkDocs serves at a base-relative URL path (`a/b/` or `a/b` -> `a/b.md` or `a/b/index.md`).
 *
 * @param {string} urlPath Decoded base-relative path.
 * @param {(relative: string) => boolean} existsFn Existence check.
 * @returns {string|null} Docs-relative `.md` path.
 */
function docAtUrl(urlPath, existsFn) {
  const directory = urlPath.replace(/\/$/, '');
  const candidates = directory === '' ? ['index.md'] : [`${directory}.md`, `${directory}/index.md`];
  return candidates.find((candidate) => isContainedPath(candidate) && existsFn(candidate)) ?? null;
}

/**
 * Classify a link whose target file exists (MkDocs rewrote it).
 *
 * @param {object} link Link parts.
 * @returns {{kind: string, out: string}} Resolution.
 */
function resolvedTarget({href, pathPart, suffix, decoded, target, fromFile, image}) {
  if (isStaticPath(target) || isLinkedImage(target, image)) {
    return {kind: 'static', out: `pathname:///${pythonQuote(target)}${suffix}`};
  }
  const kind = target.endsWith('.md') ? 'doc' : 'image';
  const unchanged = pathPart === decoded && path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), pathPart)) === target;
  return {kind, out: unchanged ? href : `${pythonQuote(relativeFrom(fromFile, target))}${suffix}`};
}

/**
 * Resolve an href that MkDocs emitted as written, the way the browser does on the page URL.
 *
 * @param {object} link Link parts.
 * @returns {{kind: string, out: string}} Resolution.
 */
function resolveAsWritten({href, suffix, fromFile, existsFn, siteUrl, image}) {
  if (!siteUrl) {
    throw new Error('resolveMkdocsLink needs options.siteUrl to resolve links that MkDocs left as written');
  }
  const base = new URL(siteUrl);
  const final = new URL(href, new URL(mkdocsPageUrl(fromFile), base));
  const broken = (out) => ({kind: 'broken', out: image ? href : out});
  if (final.origin !== base.origin || !final.pathname.startsWith(base.pathname)) {
    return broken(`${final.origin}${final.pathname}${suffix}`);
  }
  const encodedRelative = final.pathname.slice(base.pathname.length);
  const relative = pythonUnquote(encodedRelative);
  const doc = image ? null : docAtUrl(relative, existsFn);
  if (doc !== null) {
    return {kind: 'doc', out: `${pythonQuote(relativeFrom(fromFile, doc))}${suffix}`};
  }
  // MkDocs serves every docs file except Markdown, which it renders to a page URL.
  if (!relative.endsWith('.md') && isContainedPath(relative) && existsFn(relative)) {
    return isStaticPath(relative) || isLinkedImage(relative, image)
      ? {kind: 'static', out: `pathname:///${pythonQuote(relative)}${suffix}`}
      : {kind: 'image', out: `${pythonQuote(relativeFrom(fromFile, relative))}${suffix}`};
  }
  return broken(`pathname:///${encodedRelative}${suffix}`);
}

/**
 * Work out the URL MkDocs emitted for a link or image and the Docusaurus form for it.
 *
 * @param {string} href Destination as written in the Markdown source (decoded by the parser).
 * @param {string} fromFile Docs-relative path of the page.
 * @param {string} docsDir Docs directory (kept for the documented interface; lookups go through `existsFn`).
 * @param {(relative: string) => boolean} existsFn Whether a docs-relative file exists.
 * @param {{siteUrl?: string, image?: boolean}} [options] `siteUrl` is MkDocs's `site_url`; `image`
 *   selects image semantics (broken images keep their src).
 * @returns {{kind: 'doc'|'static'|'image'|'external'|'anchor'|'broken', out: string}} Resolution.
 * @throws {Error} For script-bearing URL schemes.
 */
export function resolveMkdocsLink(href, fromFile, docsDir, existsFn, options = {}) {
  assertSafeUrl(href);
  if (href === '') {
    return {kind: 'broken', out: ''};
  }
  if (HAS_PROTOCOL.test(href)) {
    return {kind: href.startsWith('pathname://') ? 'static' : 'external', out: href};
  }
  if (href.startsWith('#')) {
    return {kind: 'anchor', out: href};
  }
  const {pathPart, suffix} = splitHref(href);
  const link = {href, pathPart, suffix, fromFile, existsFn, siteUrl: options.siteUrl, image: options.image === true};
  const lastSegment = pathPart.split('/').pop();
  const mkdocsRewrites = pathPart !== '' && !href.startsWith('/') && !href.startsWith('\\') && lastSegment.includes('.');
  if (mkdocsRewrites) {
    const decoded = pythonUnquote(pathPart);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decoded)).replace(/^\.\//, '');
    if (isContainedPath(target) && existsFn(target)) {
      return resolvedTarget({...link, decoded, target});
    }
  }
  return resolveAsWritten(link);
}
