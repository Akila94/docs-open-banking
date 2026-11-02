/**
 * MkDocs `nav:` parsing and the Docusaurus `sidebars.ts` generator (`buildSidebarsTs`).
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

/** Top-level nav section -> CSS icon slug (`sidebar-section-icon-<slug>`), for this site's nav. */
export const SECTION_ICON_SLUGS = {
  'Get Started': 'get-started',
  'Install and Setup': 'install-and-setup',
  'Tryout Flows': 'tryout-flows',
  Learn: 'learn',
  Develop: 'develop',
  References: 'references',
};

/** Nav pages that belong to the site chrome, not to the sidebar. */
const SIDEBAR_EXCLUDED_FILES = new Set(['index.md', 'page-not-found.md']);

/** Reproduction command written into the header of the generated file. */
const SIDEBARS_REPRODUCE_COMMAND = 'node tools/migration/convert.mjs --docs en/docs --mkdocs en/mkdocs.yml '
  + '--fixups tools/migration/fixups/master.json --sidebars sidebars.ts';

/**
 * Render a string as a single-quoted TypeScript literal.
 *
 * @param {string} value Text.
 * @returns {string} Quoted literal with backslashes, quotes and line breaks escaped.
 */
function tsString(value) {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${escaped}'`;
}

/**
 * Convert NavNodes to rendered sidebar item lines.
 *
 * @param {NavNode[]} nodes Nav entries.
 * @param {{iconSlugs: Record<string, string>, seen: Set<string>, depth: number}} state Slugs, the
 *   doc ids already emitted (a repeat becomes a `ref`) and the nesting depth (0 = top level).
 * @returns {string[]} Lines (without the surrounding brackets), indented for `depth`.
 * @throws {Error} When a top-level category has no icon slug.
 */
function renderItems(nodes, state) {
  const pad = ' '.repeat(4 + 4 * state.depth);
  const lines = [];
  for (const node of nodes) {
    if (node.file !== undefined) {
      if (SIDEBAR_EXCLUDED_FILES.has(node.file)) {
        continue;
      }
      const id = node.file.replace(/\.md$/, '');
      if (state.seen.has(id)) {
        lines.push(`${pad}{type: 'ref', id: ${tsString(id)}},`);
      } else {
        state.seen.add(id);
        lines.push(`${pad}{type: 'doc', id: ${tsString(id)}, label: ${tsString(node.label)}},`);
      }
      continue;
    }
    const top = state.depth === 0;
    const slug = state.iconSlugs[node.label];
    if (top && !Object.hasOwn(state.iconSlugs, node.label)) {
      throw new Error(`no sidebar icon slug for top-level section: ${node.label}`);
    }
    const children = renderItems(node.children, {...state, depth: state.depth + 1});
    lines.push(
      `${pad}{`,
      `${pad}  type: 'category',`,
      `${pad}  label: ${tsString(node.label)},`,
      ...(top ? [`${pad}  className: ${tsString(`sidebar-section-icon-${slug}`)},`, `${pad}  collapsed: true,`] : []),
      `${pad}  items: [`,
      ...children,
      `${pad}  ],`,
      `${pad}},`,
    );
  }
  return lines;
}

/**
 * Generate `sidebars.ts` from the nav: one `docsSidebar`, doc ids are docs-relative paths without
 * `.md`, a file listed twice becomes a `ref` after its first occurrence, and `index.md` and
 * `page-not-found.md` are left out.
 *
 * @param {NavNode[]} nav Parsed nav.
 * @param {{iconSlugs: Record<string, string>}} options Top-level section label -> icon slug.
 * @returns {string} TypeScript source (deterministic, 2-space indent, single quotes).
 * @throws {Error} When a top-level category has no icon slug.
 */
export function buildSidebarsTs(nav, {iconSlugs}) {
  const items = renderItems(nav, {iconSlugs, seen: new Set(), depth: 0});
  return [
    '// GENERATED FILE - DO NOT EDIT.',
    '// Generated from the `nav:` of en/mkdocs.yml by tools/migration. Reproduce with:',
    `//   ${SIDEBARS_REPRODUCE_COMMAND}`,
    "import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';",
    '',
    'const sidebars: SidebarsConfig = {',
    '  docsSidebar: [',
    ...items,
    '  ],',
    '};',
    '',
    'export default sidebars;',
    '',
  ].join('\n');
}

/**
 * Docs-relative files listed in the nav (any label, including empty ones).
 *
 * @param {NavNode[]} nav Parsed nav.
 * @returns {Set<string>} Files.
 */
export function navFiles(nav) {
  return new Set(navPageLabels(nav).keys());
}
