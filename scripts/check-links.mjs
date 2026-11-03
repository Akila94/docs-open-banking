#!/usr/bin/env node
/**
 * Broken-link ratchet for the built site.
 *
 * Scans every `href` and `src` attribute in `<build>/**\/*.html`, resolves each internal URL against
 * the files that were actually built (including `#fragment` ids), and compares the breakage with a
 * committed baseline. It exits 1 when a link is newly broken AND when a baseline entry now resolves,
 * so the baseline can only shrink. Docusaurus' own checks cannot do this job: they are set to `warn`
 * (pre-existing breakage must survive the migration), and they skip `pathname://` links (the
 * click-to-enlarge image and attachment links), which become plain paths in the built HTML.
 *
 * Usage:
 *   node scripts/check-links.mjs --build build --base-url /en/latest/ \
 *        --baseline broken-links-baseline.json [--write-baseline]
 *
 * Exit codes: 0 = matches the baseline, 1 = new breakage or stale baseline, 2 = usage/IO error.
 *
 * Scope: URLs with a scheme (http, mailto, data, ...) and protocol-relative URLs are external and
 * skipped; absolute paths outside `--base-url` (for example `/en/versions/`, a different deployment)
 * are skipped too, because this build cannot answer for them. Lookups are case sensitive because
 * GitHub Pages is.
 */
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const BASE_URL_PATTERN = /^\/en\/[a-z0-9.-]+\/$/;
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const PLACEHOLDER_ORIGIN = 'https://build.invalid';
const BASELINE_DESCRIPTION = 'Pre-existing broken links, missing images and bad anchors carried over from the MkDocs site. '
  + 'Entries are only ever removed (npm run check-links fails once one is fixed); regenerate with '
  + 'node scripts/check-links.mjs --write-baseline after fixing.';
const REASONS = Object.freeze({MISSING_PAGE: 'missing-page', MISSING_ANCHOR: 'missing-anchor', EMPTY_URL: 'empty-url', INVALID_URL: 'invalid-url'});

/** Raised for bad arguments or unreadable inputs; maps to exit code 2. */
class UsageError extends Error {}

/**
 * Parse and validate the command line.
 *
 * @param {string[]} argv Arguments without the node binary and script path.
 * @returns {{build: string, baseUrl: string, baseline: string, writeBaseline: boolean}}
 * @throws {UsageError} On unknown or missing options, or a base URL that is not `/en/<version>/`.
 */
export function parseCommandLine(argv) {
  let values;
  try {
    ({values} = parseArgs({
      args: argv,
      options: {
        build: {type: 'string'},
        'base-url': {type: 'string'},
        baseline: {type: 'string'},
        'write-baseline': {type: 'boolean', default: false},
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  for (const required of ['build', 'base-url', 'baseline']) {
    if (!values[required]) throw new UsageError(`missing required option --${required}`);
  }
  if (!BASE_URL_PATTERN.test(values['base-url'])) {
    throw new UsageError(`--base-url must match ${BASE_URL_PATTERN} (got ${JSON.stringify(values['base-url'])})`);
  }
  return {build: values.build, baseUrl: values['base-url'], baseline: values.baseline, writeBaseline: values['write-baseline']};
}

/**
 * List every file under a directory as POSIX-style relative paths (sorted, for determinism).
 *
 * @param {string} root Directory to walk.
 * @returns {string[]} Relative file paths.
 */
function listFiles(root) {
  const found = [];
  const walk = (relativeDir) => {
    const entries = readdirSync(path.join(root, relativeDir), {withFileTypes: true})
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.isFile()) found.push(relativePath);
    }
  };
  walk('');
  return found;
}

/**
 * Decode the HTML entities that can appear in an attribute value.
 *
 * @param {string} value Raw attribute text.
 * @returns {string} Decoded text.
 */
function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, body) => {
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const codePoint = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
      }
    }
  });
}

/**
 * Remove HTML comments and the bodies of `<script>`/`<style>`/`<template>` blocks, so that markup
 * quoted inside them is never mistaken for real links.
 *
 * @param {string} html Page source.
 * @returns {string} Page source without those blocks.
 */
function stripInertBlocks(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
}

const TAG_PATTERN = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE_PATTERN = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Extract the attributes of every real start tag. Escaped text (`&lt;a href=...`) never matches
 * because only literal `<` opens a tag.
 *
 * @param {string} html Page source.
 * @returns {Array<Record<string, string>>} One attribute map (lower-cased names, decoded values) per tag.
 */
function extractTags(html) {
  const tags = [];
  for (const [, , attributeText] of stripInertBlocks(html).matchAll(TAG_PATTERN)) {
    const attributes = {};
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributeText.matchAll(ATTRIBUTE_PATTERN)) {
      const raw = doubleQuoted ?? singleQuoted ?? unquoted;
      attributes[name.toLowerCase()] = raw === undefined ? '' : decodeEntities(raw);
    }
    tags.push(attributes);
  }
  return tags;
}

/**
 * Map a built file to the public route it is served at.
 *
 * @param {string} relativeFile Path relative to the build directory, e.g. `learn/x/index.html`.
 * @param {string} baseUrl Site base URL, e.g. `/en/latest/`.
 * @returns {string} The route, e.g. `/en/latest/learn/x/`.
 */
function routeOf(relativeFile, baseUrl) {
  if (relativeFile === 'index.html') return baseUrl;
  if (relativeFile.endsWith('/index.html')) return `${baseUrl}${relativeFile.slice(0, -'index.html'.length)}`;
  return `${baseUrl}${relativeFile}`;
}

/**
 * Resolves internal URLs against the set of built files.
 */
class BuildIndex {
  /**
   * @param {string} buildDir Build output directory.
   * @param {string} baseUrl Site base URL.
   */
  constructor(buildDir, baseUrl) {
    this.buildDir = buildDir;
    this.baseUrl = baseUrl;
    this.files = new Set(listFiles(buildDir));
    this.anchorCache = new Map();
  }

  /** @returns {string[]} The built HTML files, sorted. */
  htmlFiles() {
    return [...this.files].filter((file) => file.endsWith('.html')).sort();
  }

  /**
   * Find the built file that serves a URL path (relative to the base URL).
   *
   * @param {string} relativePath Decoded path below the base URL ('' is the site root).
   * @returns {string | null} The built file, or null when nothing serves it.
   */
  fileFor(relativePath) {
    if (relativePath === '' || relativePath.endsWith('/')) {
      const index = `${relativePath}index.html`;
      return this.files.has(index) ? index : null;
    }
    if (this.files.has(relativePath)) return relativePath;
    const asDirectory = `${relativePath}/index.html`;
    return this.files.has(asDirectory) ? asDirectory : null;
  }

  /**
   * Whether an HTML file defines an element with the given id (or anchor name).
   *
   * @param {string} file Built HTML file.
   * @param {string} fragment Decoded fragment without the leading `#`.
   * @returns {boolean} True when the fragment resolves.
   */
  hasAnchor(file, fragment) {
    if (!this.anchorCache.has(file)) {
      const anchors = new Set();
      for (const attributes of extractTags(readFileSync(path.join(this.buildDir, file), 'utf8'))) {
        if (attributes.id) anchors.add(attributes.id);
        if (attributes.name) anchors.add(attributes.name);
      }
      this.anchorCache.set(file, anchors);
    }
    return this.anchorCache.get(file).has(fragment);
  }
}

/**
 * Decide whether one URL found on a page is broken.
 *
 * @param {BuildIndex} index Built files.
 * @param {string} pageRoute Route of the page holding the URL.
 * @param {string} rawUrl The URL as written (entities decoded).
 * @returns {string | null} A reason from REASONS, or null when the URL is fine or out of scope.
 */
export function classifyUrl(index, pageRoute, rawUrl) {
  const url = rawUrl.trim();
  if (url === '') return REASONS.EMPTY_URL;
  if (SCHEME_PATTERN.test(url) || url.startsWith('//')) return null;

  let resolved;
  let pathname;
  let fragment;
  try {
    resolved = new URL(url, PLACEHOLDER_ORIGIN + pageRoute);
    pathname = decodeURIComponent(resolved.pathname);
    fragment = decodeURIComponent(resolved.hash.slice(1));
  } catch {
    return REASONS.INVALID_URL;
  }
  if (!pathname.startsWith(index.baseUrl)) return null;

  const relativePath = pathname.slice(index.baseUrl.length);
  if (relativePath.split('/').includes('..')) return REASONS.INVALID_URL;
  const file = index.fileFor(relativePath);
  if (file === null) return REASONS.MISSING_PAGE;
  // The HTML spec makes '' and 'top' valid on every page.
  if (fragment === '' || fragment === 'top' || !file.endsWith('.html')) return null;
  return index.hasAnchor(file, fragment) ? null : REASONS.MISSING_ANCHOR;
}

/**
 * Collect every broken internal link in a build.
 *
 * @param {string} buildDir Build output directory.
 * @param {string} baseUrl Site base URL.
 * @returns {Array<{page: string, attribute: string, url: string, reason: string}>} Unique entries, sorted.
 */
export function findBrokenLinks(buildDir, baseUrl) {
  const index = new BuildIndex(buildDir, baseUrl);
  const unique = new Map();
  for (const file of index.htmlFiles()) {
    const page = routeOf(file, baseUrl);
    for (const attributes of extractTags(readFileSync(path.join(buildDir, file), 'utf8'))) {
      for (const attribute of ['href', 'src']) {
        if (!(attribute in attributes)) continue;
        const reason = classifyUrl(index, page, attributes[attribute]);
        if (reason) unique.set(entryKey({page, attribute, url: attributes[attribute], reason}), {page, attribute, url: attributes[attribute], reason});
      }
    }
  }
  return sortEntries([...unique.values()]);
}

/** @returns {string} A stable identity for a baseline entry. */
function entryKey(entry) {
  return JSON.stringify([entry.page, entry.attribute, entry.url, entry.reason]);
}

/** @returns {Array} The entries sorted by identity, so files and output are deterministic. */
function sortEntries(entries) {
  return [...entries].sort((left, right) => (entryKey(left) < entryKey(right) ? -1 : entryKey(left) > entryKey(right) ? 1 : 0));
}

/**
 * Read and validate the baseline file.
 *
 * @param {string} baselinePath Path of the baseline JSON.
 * @returns {Array} Its entries.
 * @throws {UsageError} When the file is unreadable or not shaped `{entries: [{page, attribute, url, reason}]}`.
 */
function readBaseline(baselinePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read baseline ${baselinePath}: ${error.message}`);
  }
  const valid = parsed && Array.isArray(parsed.entries) && parsed.entries.every((entry) => (
    entry && ['page', 'attribute', 'url', 'reason'].every((field) => typeof entry[field] === 'string')
  ));
  if (!valid) throw new UsageError(`baseline ${baselinePath} must be {"entries": [{page, attribute, url, reason}, ...]}`);
  return parsed.entries;
}

/**
 * Collect the free-text `note` of each entry in an existing baseline, so a regenerated baseline
 * keeps the explanations. A missing or unreadable baseline simply yields no notes.
 *
 * @param {string} baselinePath Path of the baseline JSON.
 * @returns {Map<string, string>} Notes by entry identity.
 */
function readExistingNotes(baselinePath) {
  try {
    return new Map(readBaseline(baselinePath).filter((entry) => typeof entry.note === 'string').map((entry) => [entryKey(entry), entry.note]));
  } catch {
    return new Map();
  }
}

/** @returns {Array} The entries with their previous notes re-attached. */
function carryOverNotes(entries, notes) {
  return entries.map((entry) => (notes.has(entryKey(entry)) ? {...entry, note: notes.get(entryKey(entry))} : entry));
}

/** Format entries one per line for the console. */
function describe(entries) {
  return entries.map((entry) => `  ${entry.page}  ${entry.attribute}=${JSON.stringify(entry.url)}  [${entry.reason}]`).join('\n');
}

/**
 * Run the check.
 *
 * @param {string[]} argv Command-line arguments.
 * @returns {number} The process exit code.
 */
export function run(argv) {
  let options;
  let broken;
  try {
    options = parseCommandLine(argv);
    broken = findBrokenLinks(options.build, options.baseUrl);
  } catch (error) {
    if (!(error instanceof UsageError) && error.code !== 'ENOENT') throw error;
    console.error(`check-links: ${error.message}`);
    return 2;
  }

  if (options.writeBaseline) {
    const withNotes = carryOverNotes(broken, readExistingNotes(options.baseline));
    writeFileSync(options.baseline, `${JSON.stringify({description: BASELINE_DESCRIPTION, entries: withNotes}, null, 2)}\n`);
    console.log(`check-links: wrote ${broken.length} entries to ${options.baseline}`);
    return 0;
  }

  let baseline;
  try {
    baseline = readBaseline(options.baseline);
  } catch (error) {
    console.error(`check-links: ${error.message}`);
    return 2;
  }
  const baselineKeys = new Set(baseline.map(entryKey));
  const brokenKeys = new Set(broken.map(entryKey));
  const newlyBroken = broken.filter((entry) => !baselineKeys.has(entryKey(entry)));
  const nowFixed = sortEntries(baseline.filter((entry) => !brokenKeys.has(entryKey(entry))));

  if (newlyBroken.length > 0) console.error(`check-links: ${newlyBroken.length} NEW broken link(s):\n${describe(newlyBroken)}`);
  if (nowFixed.length > 0) {
    console.error(`check-links: ${nowFixed.length} baseline entr${nowFixed.length === 1 ? 'y is' : 'ies are'} now fixed; `
      + `remove them (node scripts/check-links.mjs ... --write-baseline):\n${describe(nowFixed)}`);
  }
  if (newlyBroken.length > 0 || nowFixed.length > 0) return 1;
  console.log(`check-links: OK (${broken.length} known broken link(s), all in the baseline)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
