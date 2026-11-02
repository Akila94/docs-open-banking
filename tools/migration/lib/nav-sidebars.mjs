/**
 * MkDocs `nav:` parsing. The sidebar generator (`buildSidebarsTs`) is added by a later task.
 *
 * Only the `nav:` subtree of `mkdocs.yml` is parsed. js-yaml is used with its safe default schema
 * plus an inert handler for `!!python/name:` tags (as in `emoji_generator`), which are kept as
 * plain marker objects and never resolved or executed.
 */
import * as yaml from 'js-yaml';

/**
 * @typedef {object} NavNode
 * @property {string} label Nav label (may be empty, as for `page-not-found.md`).
 * @property {string} [file] Docs-relative Markdown file for a page entry.
 * @property {NavNode[]} [children] Child entries for a section.
 */

const PYTHON_NAME_PREFIX = 'tag:yaml.org,2002:python/name:';

/** Inert stand-in for Python object references (load-only); any reaching the nav is rejected. */
const PYTHON_NAME_TAG = yaml.defineScalarTag(PYTHON_NAME_PREFIX, {
  matchByTagPrefix: true,
  resolve: (_source, _isExplicit, tagName) => ({pythonName: tagName.slice(PYTHON_NAME_PREFIX.length)}),
  identify: () => false,
});

/** js-yaml's safe core schema (no `!!merge`, no code-executing tags) plus the inert tag. */
const MKDOCS_SCHEMA = yaml.CORE_SCHEMA.withTags(PYTHON_NAME_TAG);

/**
 * Cut the `nav:` block (from `nav:` to the next top-level key) out of the YAML text.
 *
 * @param {string} mkdocsYml Whole `mkdocs.yml`.
 * @returns {string} YAML text containing only the `nav:` mapping.
 * @throws {Error} When the document has no top-level `nav:` key.
 */
function extractNavYaml(mkdocsYml) {
  const lines = mkdocsYml.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^nav:\s*$/.test(line));
  if (start === -1) {
    throw new Error('mkdocs.yml has no `nav:` section');
  }
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z_][\w-]*\s*:/.test(lines[end])) {
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Convert one YAML nav entry into a NavNode.
 *
 * @param {unknown} entry `{label: file}`, `{label: [children]}` or a bare file string.
 * @returns {NavNode} The node.
 * @throws {Error} For any other shape (external links, Python objects, multi-key maps).
 */
function toNavNode(entry) {
  if (typeof entry === 'string') {
    return {label: '', file: entry};
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const keys = Object.keys(entry);
    if (keys.length === 1) {
      const label = keys[0];
      const value = entry[label];
      if (typeof value === 'string' && value.endsWith('.md')) {
        return {label, file: value};
      }
      if (Array.isArray(value)) {
        return {label, children: value.map(toNavNode)};
      }
    }
  }
  throw new Error(`Unsupported nav entry: ${JSON.stringify(entry).slice(0, 120)}`);
}

/**
 * Parse the `nav:` tree of `mkdocs.yml`.
 *
 * @param {string} mkdocsYml Whole `mkdocs.yml` content.
 * @returns {NavNode[]} The top-level nav entries in document order.
 * @throws {Error} When `nav:` is missing, not a list, or contains an unsupported entry.
 */
export function parseNav(mkdocsYml) {
  const document = yaml.load(extractNavYaml(mkdocsYml), {schema: MKDOCS_SCHEMA});
  if (!document || !Array.isArray(document.nav)) {
    throw new Error('mkdocs.yml `nav:` must be a list');
  }
  return document.nav.map(toNavNode);
}

/**
 * Map every nav file to the label of its first (depth-first) occurrence.
 * Empty labels are skipped so the caller falls back to MkDocs's title rules.
 *
 * @param {NavNode[]} nav Parsed nav.
 * @returns {Map<string, string>} Docs-relative file -> nav label, in nav order.
 */
export function navTitles(nav) {
  const titles = new Map();
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.file && node.label !== '' && !titles.has(node.file)) {
        titles.set(node.file, node.label);
      }
      if (node.children) {
        visit(node.children);
      }
    }
  };
  visit(nav);
  return titles;
}

/**
 * Map every nav file to the label of its first (depth-first) occurrence, keeping empty labels.
 * MkDocs keeps an empty label as the page title (`''` is not None), and Material then shows the
 * site name; `pageTitle` needs to know about such pages.
 *
 * @param {NavNode[]} nav Parsed nav.
 * @returns {Map<string, string>} Docs-relative file -> nav label (possibly empty), in nav order.
 */
export function navPageLabels(nav) {
  const labels = new Map();
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.file && !labels.has(node.file)) {
        labels.set(node.file, node.label);
      }
      if (node.children) {
        visit(node.children);
      }
    }
  };
  visit(nav);
  return labels;
}

/**
 * Read the top-level `site_name` and `site_url` of `mkdocs.yml` (the rest of the file is ignored).
 *
 * @param {string} mkdocsYml File content.
 * @returns {{siteName: string, siteUrl: string}} Settings.
 * @throws {Error} When either is missing, or `site_url` is not an absolute http(s) URL.
 */
export function parseSiteSettings(mkdocsYml) {
  const scalar = (key) => {
    const line = mkdocsYml.split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`));
    const value = line === undefined ? undefined : yaml.load(line, {schema: yaml.CORE_SCHEMA})?.[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`mkdocs.yml must define a top-level ${key}`);
    }
    return value.trim();
  };
  const siteUrl = scalar('site_url');
  const parsed = new URL(siteUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('mkdocs.yml site_url must be an http(s) URL');
  }
  return {siteName: scalar('site_name'), siteUrl: parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`};
}
