/**
 * Per-file conversion pipeline: front matter (pass 1), block passes (2–8) and the MDX imports
 * they need. Inline passes (Task 4) plug in after `convertBlocks`.
 */
import path from 'node:path';
import {splitFrontMatter, joinFrontMatter, mapTemplate, FrontMatterError} from './frontmatter.mjs';
import {ConversionError, excerpt} from './errors.mjs';
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
 * `splitFrontMatter`, with errors located as `file:line`.
 *
 * @param {string} source Normalised file content.
 * @param {string} file Docs-relative path.
 * @returns {{data: object|null, body: string}} Front matter and body.
 * @throws {ConversionError} For malformed front matter.
 */
function readFrontMatter(source, file) {
  try {
    return splitFrontMatter(source);
  } catch (error) {
    if (error instanceof FrontMatterError) {
      throw new ConversionError(file, error.line, `front matter: ${excerpt(error.message, 120)}`);
    }
    throw error;
  }
}

/**
 * `mapTemplate`, with errors located at the `template:` line.
 *
 * @param {object} data Parsed front matter.
 * @param {string} source Normalised file content (to find the `template:` line).
 * @param {string} file Docs-relative path.
 * @returns {object} Mapped front matter.
 * @throws {ConversionError} For an unknown template.
 */
function mapFrontMatter(data, source, file) {
  try {
    return mapTemplate(data);
  } catch (error) {
    const index = source.split('\n').findIndex((line) => /^template\s*:/.test(line));
    throw new ConversionError(file, index === -1 ? 1 : index + 1, `front matter: ${excerpt(error.message, 120)}`);
  }
}

/**
 * Convert one MkDocs Markdown file to Docusaurus MDX (block level).
 *
 * @param {string} source File content.
 * @param {{file: string, stats?: object, fixupLines?: Set<number>}} ctx `file` is the docs-relative
 *   path (errors, imports); `fixupLines` are the 1-based lines a fixup produced in `source`.
 * @returns {{text: string, imports: Set<string>}} Converted file and the components it imports.
 * @throws {ConversionError} With `file:line`, including front matter problems.
 */
export function convertFile(source, ctx) {
  const normalized = source.replace(/\r\n?/g, '\n');
  const {data, body} = readFrontMatter(normalized, ctx.file);
  const frontMatter = data === null ? null : mapFrontMatter(data, normalized, ctx.file);
  const frontMatterLines = normalized.slice(0, normalized.length - body.length).split('\n').length - 1;
  const {imports: existing, rest, removedLines} = splitImports(body);
  const converted = convertBlocks(rest, {
    file: ctx.file,
    lineOffset: frontMatterLines + removedLines,
    stats: ctx.stats,
    fixupLines: ctx.fixupLines,
  });
  const imports = new Set([...existing, ...converted.imports]);
  const importLines = renderImports(imports, ctx.file);
  const content = importLines.length > 0
    ? `${importLines.join('\n')}\n\n${converted.text.replace(/^\n+/, '')}`
    : converted.text;
  return {text: joinFrontMatter(frontMatter, content), imports};
}
