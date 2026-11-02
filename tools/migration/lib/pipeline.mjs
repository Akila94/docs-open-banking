/**
 * Per-file conversion pipeline: front matter (pass 1), block passes (2–8), then, when a site
 * context is given, raw HTML -> JSX (pass 9) and the inline passes (10–14), and the MDX imports
 * the result needs.
 */
import path from 'node:path';
import {splitFrontMatter, joinFrontMatter, mapTemplate, FrontMatterError} from './frontmatter.mjs';
import {ConversionError, excerpt} from './errors.mjs';
import {convertBlocks} from './pymd-blocks.mjs';
import {htmlToJsx} from './html-to-jsx.mjs';
import {pagePolicy} from './html/policy.mjs';
import {convertInline} from './inline-mdx.mjs';

/** Docs-relative location of the deprecated-banner partial after the rename. */
export const BANNER_PARTIAL = 'includes/_deprecated-banner.md';

const TABS_IMPORTS = ["import Tabs from '@theme/Tabs';", "import TabItem from '@theme/TabItem';"];
const LINK_IMPORT = "import Link from '@docusaurus/Link';";
/** Snippet sources become Docusaurus partials, which are not pages: they get no title. */
const PARTIAL_DIR = 'includes/';
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
  if (imports.has('Link')) {
    lines.push(LINK_IMPORT);
  }
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
    } else if (line === LINK_IMPORT) {
      imports.add('Link');
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
 * Convert the raw HTML blocks the block passes isolated (pass 9) and locate them and the MDX
 * comments in the result, so the inline passes leave them alone.
 *
 * @param {string} body Block passes' output.
 * @param {Array<{kind: string, start: number, end: number, sourceLine: number}>} regions Output line ranges.
 * @param {object} options `file`, `policy`, `imports` (receives `Link`), `converted` (already-converted file).
 * @returns {{text: string, masks: Array<{start: number, end: number}>, rawHasH1: boolean}} Result.
 */
function convertRawRegions(body, regions, {file, policy, imports, converted}) {
  const lines = body.split('\n');
  const out = [];
  const maskedLines = [];
  let cursor = 0;
  let rawHasH1 = false;
  for (const region of [...regions].sort((first, second) => first.start - second.start)) {
    out.push(...lines.slice(cursor, region.start));
    let block = lines.slice(region.start, region.end + 1);
    if (region.kind === 'html') {
      const html = block.join('\n');
      rawHasH1 ||= html.includes('<h1');
      block = htmlToJsx(html, {...policy, file, line: region.sourceLine, imports, converted}).split('\n');
    }
    maskedLines.push([out.length, out.length + block.length - 1]);
    out.push(...block);
    cursor = region.end + 1;
  }
  out.push(...lines.slice(cursor));
  const lineStarts = [];
  let offset = 0;
  for (const line of out) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const masks = maskedLines.map(([first, last]) => ({start: lineStarts[first], end: lineStarts[last] + out[last].length}));
  return {text: out.join('\n'), masks, rawHasH1};
}

/**
 * Shift report lines from body lines to lines of the final file.
 *
 * @param {object} report Inline report.
 * @param {number} offset Lines before the body.
 * @returns {object} Report with shifted lines.
 */
function shiftReport(report, offset) {
  return Object.fromEntries(Object.entries(report).map(([key, entries]) => [
    key, entries.map((entry) => ({...entry, line: entry.line + offset})),
  ]));
}

/**
 * Convert one MkDocs Markdown file to Docusaurus MDX.
 *
 * Without `ctx.site` only the block passes run (stage 1; used by the block-pass unit tests).
 * With it, raw HTML becomes JSX and the inline passes run (stage 2), and `title:` is written.
 *
 * @param {string} source File content.
 * @param {object} ctx Context.
 * @param {string} ctx.file Docs-relative path (errors, imports, link resolution).
 * @param {object} [ctx.stats] Receives block-pass author-intent counters.
 * @param {Set<number>} [ctx.fixupLines] 1-based lines of `source` that a fixup produced.
 * @param {{existsFn: Function, titles: Map<string, string>, siteName: string, siteUrl: string, docsDir?: string}} [ctx.site]
 *   Site context for stage 2.
 * @returns {{text: string, imports: Set<string>, report: object|null}} Converted file, the
 *   components it imports, and the stage-2 report (lines are lines of the converted file).
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
  let text = converted.text;
  let finalFrontMatter = frontMatter;
  let report = null;
  if (ctx.site) {
    const policy = pagePolicy(ctx.file, frontMatter);
    // Converted pages always carry `title:`; MkDocs sources never do (see `withTitle`).
    const alreadyConverted = Object.hasOwn(data ?? {}, 'title');
    const raw = convertRawRegions(text, converted.regions, {file: ctx.file, policy, imports, converted: alreadyConverted});
    const inline = convertInline(raw.text, {
      ...ctx.site,
      file: ctx.file,
      masks: raw.masks,
      policy,
      converted: alreadyConverted,
      originalBody: rest,
      mkdocsShowsTitle: !String(data?.template ?? '').endsWith('redoc.html') && !raw.rawHasH1,
      lineOffset: frontMatterLines,
    });
    text = inline.text;
    report = inline.report;
    finalFrontMatter = withTitle(frontMatter, ctx.file, inline);
  }
  const importLines = renderImports(imports, ctx.file);
  const leading = /^\n*/.exec(text)[0].length;
  const content = importLines.length > 0 ? `${importLines.join('\n')}\n\n${text.slice(leading)}` : text;
  const output = joinFrontMatter(finalFrontMatter, content);
  if (report !== null) {
    const linesBeforeContent = output.slice(0, output.length - content.length).split('\n').length - 1;
    const bodyOffset = linesBeforeContent + (importLines.length > 0 ? importLines.length + 1 - leading : 0);
    report = shiftReport(report, bodyOffset);
  }
  return {text: output, imports, report};
}

/**
 * Add `title` (and `hide_title`) to the front matter unless the page already has a title
 * (converted pages always do; MkDocs sources never do).
 *
 * @param {object|null} frontMatter Mapped front matter.
 * @param {string} file Docs-relative path.
 * @param {{title: string, hideTitle: boolean}} inline Inline-pass result.
 * @returns {object|null} Front matter.
 */
function withTitle(frontMatter, file, inline) {
  if (file.startsWith(PARTIAL_DIR) || Object.hasOwn(frontMatter ?? {}, 'title')) {
    return frontMatter;
  }
  return {...frontMatter, title: inline.title, ...(inline.hideTitle ? {hide_title: true} : {})};
}
