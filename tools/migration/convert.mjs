#!/usr/bin/env node
/**
 * MkDocs -> Docusaurus MDX converter CLI.
 *
 *   node tools/migration/convert.mjs --docs en/docs --mkdocs en/mkdocs.yml \
 *     [--fixups tools/migration/fixups/master.json] [--check] [--report <file.json>] [--sidebars <sidebars.ts>]
 *
 * - Reads every `.md` under `--docs` (sorted, symlinks skipped), applies the fixups (pass 0),
 *   converts each file (block passes, raw HTML -> JSX, inline passes) and writes it back in place.
 * - Every converted file is compiled with `@mdx-js/mdx` (remark-gfm + remark-directive, as
 *   Docusaurus does); the run fails at the first file that does not compile, naming file:line:column.
 * - `--sidebars` writes the generated `sidebars.ts` (from the `nav:` of `--mkdocs`; skipped by `--check`,
 *   which instead reports it as changed when the file on disk differs).
 * - `--check` writes nothing and exits 1 if any file would change.
 * - Fixups target the MkDocs sources: omit `--fixups` when re-running on converted output
 *   (for example `--check` after the conversion has been committed).
 * - `--report` writes a deterministic JSON summary (no timestamps): block-pass author-intent sites,
 *   and per file the broken links, missing images, heading-id overrides and other inline sites
 *   (lines are lines of the converted file).
 * Exit codes: 0 success, 1 check found changes, 2 usage or conversion error.
 */
import {readFileSync, writeFileSync, readdirSync, lstatSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';

import {compile} from '@mdx-js/mdx';
import remarkDirective from 'remark-directive';
import remarkGfm from 'remark-gfm';

import {applyFixupsWithLines} from './lib/fixups.mjs';
import {excerpt} from './lib/errors.mjs';
import {createExistsFn} from './lib/links.mjs';
import {parseNav, navTitles, navPageLabels, navFiles, parseSiteSettings, buildSidebarsTs, SECTION_ICON_SLUGS} from './lib/nav-sidebars.mjs';
import {convertFile} from './lib/pipeline.mjs';

/**
 * Collect docs-relative paths of Markdown files, sorted, without following symlinks.
 *
 * @param {string} docsRoot Absolute docs directory.
 * @returns {string[]} POSIX relative paths.
 */
export function listMarkdownFiles(docsRoot) {
  const found = [];
  const walk = (relativeDir) => {
    const entries = readdirSync(path.join(docsRoot, relativeDir), {withFileTypes: true})
      .map((entry) => entry.name)
      .sort();
    for (const name of entries) {
      const relative = relativeDir === '' ? name : `${relativeDir}/${name}`;
      const stats = lstatSync(path.join(docsRoot, relative));
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        walk(relative);
      } else if (stats.isFile() && name.endsWith('.md')) {
        found.push(relative);
      }
    }
  };
  walk('');
  return found;
}

/**
 * Resolve a docs-relative path and make sure it stays inside the docs directory.
 *
 * @param {string} docsRoot Absolute docs directory.
 * @param {string} relative Docs-relative path.
 * @returns {string} Absolute path.
 * @throws {Error} When the path escapes the docs directory.
 */
function insideDocs(docsRoot, relative) {
  const absolute = path.resolve(docsRoot, relative);
  if (!absolute.startsWith(docsRoot + path.sep)) {
    throw new Error(`refusing to touch a path outside the docs directory: ${relative}`);
  }
  return absolute;
}

/**
 * Read a text file, or null when it does not exist.
 *
 * @param {string} file Path.
 * @returns {string|null} Content or null.
 */
function readTextIfExists(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Compile converted files as MDX, in order; report the first failure.
 *
 * @param {Map<string, string>} outputs Docs-relative path -> converted content.
 * @returns {Promise<string|null>} `file:line:column: reason` of the first failure, or null.
 */
async function compileAll(outputs) {
  for (const [file, text] of outputs) {
    try {
      await compile(text, {remarkPlugins: [remarkGfm, remarkDirective]});
    } catch (error) {
      return `${file}:${error.line ?? '?'}:${error.column ?? '?'}: ${excerpt(error.reason ?? error.message, 200)}`;
    }
  }
  return null;
}

/**
 * Summarise the per-file inline reports.
 *
 * @param {Map<string, object>} reports Docs-relative path -> inline report.
 * @returns {object} Totals and the non-empty per-file entries.
 */
function summariseInline(reports) {
  const totals = {};
  const files = {};
  for (const [file, report] of reports) {
    const entries = Object.entries(report).filter(([, list]) => list.length > 0);
    for (const [key, list] of Object.entries(report)) {
      totals[key] = (totals[key] ?? 0) + list.length;
    }
    if (entries.length > 0) {
      files[file] = Object.fromEntries(entries);
    }
  }
  return {totals, files};
}

/**
 * Run the conversion.
 *
 * @param {string[]} argv Command-line arguments (without node and script).
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  const {values} = parseArgs({
    args: argv,
    options: {
      docs: {type: 'string'},
      mkdocs: {type: 'string'},
      fixups: {type: 'string'},
      check: {type: 'boolean', default: false},
      report: {type: 'string'},
      sidebars: {type: 'string'},
    },
    strict: true,
  });
  if (!values.docs || !values.mkdocs) {
    console.error('usage: convert.mjs --docs <dir> --mkdocs <mkdocs.yml> [--fixups <file.json>] [--check] [--report <file.json>] [--sidebars <sidebars.ts>]');
    return 2;
  }
  const docsRoot = path.resolve(values.docs);
  const mkdocsYml = readFileSync(values.mkdocs, 'utf8');
  const nav = parseNav(mkdocsYml);
  const titles = navTitles(nav);
  const site = {
    ...parseSiteSettings(mkdocsYml),
    titles: navPageLabels(nav),
    navFiles: navFiles(nav),
    docsDir: docsRoot,
    existsFn: createExistsFn(docsRoot),
  };
  const files = new Map(listMarkdownFiles(docsRoot).map((file) => [file, readFileSync(insideDocs(docsRoot, file), 'utf8')]));
  const fixups = values.fixups ? JSON.parse(readFileSync(values.fixups, 'utf8')) : [];
  const {files: fixed, fixupLines} = applyFixupsWithLines(files, fixups);
  console.error(`convert: ${files.size} files, ${fixups.length} fixups applied`);

  const stats = {nestedList: 0, listNotParagraph: 0, sites: []};
  const changed = [];
  const imports = {};
  const outputs = new Map();
  const inlineReports = new Map();
  for (const [file, content] of fixed) {
    const {text, imports: used, report} = convertFile(content, {file, stats, fixupLines: fixupLines.get(file), site});
    outputs.set(file, text);
    inlineReports.set(file, report);
    if (used.size > 0) {
      imports[file] = [...used].sort();
    }
    if (text !== files.get(file)) {
      changed.push(file);
    }
  }
  const compileFailure = await compileAll(outputs);
  if (compileFailure !== null) {
    console.error(`convert: MDX compile failed: ${compileFailure}`);
    return 2;
  }
  const sidebarsTs = buildSidebarsTs(nav, {iconSlugs: SECTION_ICON_SLUGS});
  const sidebarsChanged = values.sidebars !== undefined && readTextIfExists(values.sidebars) !== sidebarsTs;
  if (!values.check) {
    for (const file of changed) {
      writeFileSync(insideDocs(docsRoot, file), outputs.get(file), 'utf8');
    }
    if (sidebarsChanged) {
      writeFileSync(values.sidebars, sidebarsTs, 'utf8');
    }
  }
  if (values.report) {
    const report = {
      files: files.size,
      changed: changed.length,
      fixups: fixups.map((fixup) => fixup.id),
      navTitles: titles.size,
      authorIntent: stats,
      imports,
      inline: summariseInline(inlineReports),
    };
    writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (values.check) {
    for (const file of changed) {
      console.error(`would change: ${file}`);
    }
    if (sidebarsChanged) {
      console.error(`would change: ${values.sidebars}`);
    }
    console.error(`convert --check: ${changed.length + (sidebarsChanged ? 1 : 0)} file(s) would change`);
    return changed.length > 0 || sidebarsChanged ? 1 : 0;
  }
  console.error(`convert: ${outputs.size} file(s) compile as MDX; ${changed.length} file(s) written`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(`convert: ${error.message}`);
    process.exitCode = 2;
  });
}
