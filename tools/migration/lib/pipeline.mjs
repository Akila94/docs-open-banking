/**
 * Per-file conversion pipeline: front matter (pass 1), block passes (2–8) and the MDX imports
 * they need. Inline passes (Task 4) plug in after `convertBlocks`.
 */
import path from 'node:path';
import {splitFrontMatter, joinFrontMatter, mapTemplate} from './frontmatter.mjs';
import {convertBlocks} from './pymd-blocks.mjs';

/** Docs-relative location of the deprecated-banner partial after the rename. */
export const BANNER_PARTIAL = 'includes/_deprecated-banner.md';

const TABS_IMPORTS = ["import Tabs from '@theme/Tabs';", "import TabItem from '@theme/TabItem';"];
const BANNER_IMPORT = /^import DeprecatedBanner from '[^']+';$/;

/**
 * File-relative import specifier for the banner partial.
 *
 * @param {string} file Docs-relative path of the importing file.
 * @returns {string} Specifier starting with `./` or `../`.
 */
function bannerSpecifier(file) {
  const relative = path.posix.relative(path.posix.dirname(file), BANNER_PARTIAL);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Render the import block for the components a file uses (fixed order, deterministic).
 *
 * @param {Set<string>} imports Component names.
 * @param {string} file Docs-relative path.
 * @returns {string[]} Import lines.
 */
export function renderImports(imports, file) {
  const lines = [];
  if (imports.has('Tabs')) {
    lines.push(...TABS_IMPORTS);
  }
  if (imports.has('DeprecatedBanner')) {
    lines.push(`import DeprecatedBanner from '${bannerSpecifier(file)}';`);
  }
  return lines;
}

/**
 * Remove a converter-generated import block from the start of a body (for idempotent re-runs).
 *
 * @param {string} body File body.
 * @returns {{imports: Set<string>, rest: string, removedLines: number}} Imports found, the body
 *   without them (and the blank lines after them), and how many lines were removed.
 */
function splitImports(body) {
  const lines = body.split('\n');
  const imports = new Set();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (TABS_IMPORTS.includes(line)) {
      imports.add('Tabs');
    } else if (BANNER_IMPORT.test(line)) {
      imports.add('DeprecatedBanner');
    } else {
      break;
    }
    index += 1;
  }
  if (imports.size === 0) {
    return {imports, rest: body, removedLines: 0};
  }
  while (index < lines.length - 1 && lines[index] === '') {
    index += 1;
  }
  return {imports, rest: lines.slice(index).join('\n'), removedLines: index};
}

/**
 * Convert one MkDocs Markdown file to Docusaurus MDX (block level).
 *
 * @param {string} source File content.
 * @param {{file: string, stats?: object}} ctx `file` is the docs-relative path (errors, imports).
 * @returns {{text: string, imports: Set<string>}} Converted file and the components it imports.
 * @throws {Error} ConversionError (`file:line`) or a front matter error.
 */
export function convertFile(source, ctx) {
  const normalized = source.replace(/\r\n?/g, '\n');
  const {data, body} = splitFrontMatter(normalized);
  const frontMatter = data === null ? null : mapTemplate(data);
  const frontMatterLines = normalized.slice(0, normalized.length - body.length).split('\n').length - 1;
  const {imports: existing, rest, removedLines} = splitImports(body);
  const converted = convertBlocks(rest, {file: ctx.file, lineOffset: frontMatterLines + removedLines, stats: ctx.stats});
  const imports = new Set([...existing, ...converted.imports]);
  const importLines = renderImports(imports, ctx.file);
  const content = importLines.length > 0
    ? `${importLines.join('\n')}\n\n${converted.text.replace(/^\n+/, '')}`
    : converted.text;
  return {text: joinFrontMatter(frontMatter, content), imports};
}
