#!/usr/bin/env node
/**
 * MkDocs -> Docusaurus MDX converter CLI.
 *
 *   node tools/migration/convert.mjs --docs en/docs --mkdocs en/mkdocs.yml \
 *     [--fixups tools/migration/fixups/master.json] [--check] [--report <file.json>]
 *
 * - Reads every `.md` under `--docs` (sorted, symlinks skipped), applies the fixups (pass 0),
 *   converts each file and writes it back in place.
 * - `--check` writes nothing and exits 1 if any file would change.
 * - Fixups target the MkDocs sources: omit `--fixups` when re-running on converted output
 *   (for example `--check` after the conversion has been committed).
 * - `--report` writes a deterministic JSON summary (no timestamps).
 * Exit codes: 0 success, 1 check found changes, 2 usage or conversion error.
 */
import {readFileSync, writeFileSync, readdirSync, lstatSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';

import {applyFixups} from './lib/fixups.mjs';
import {parseNav, navTitles} from './lib/nav-sidebars.mjs';
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
 * Run the conversion.
 *
 * @param {string[]} argv Command-line arguments (without node and script).
 * @returns {number} Process exit code.
 */
export function main(argv) {
  const {values} = parseArgs({
    args: argv,
    options: {
      docs: {type: 'string'},
      mkdocs: {type: 'string'},
      fixups: {type: 'string'},
      check: {type: 'boolean', default: false},
      report: {type: 'string'},
    },
    strict: true,
  });
  if (!values.docs || !values.mkdocs) {
    console.error('usage: convert.mjs --docs <dir> --mkdocs <mkdocs.yml> [--fixups <file.json>] [--check] [--report <file.json>]');
    return 2;
  }
  const docsRoot = path.resolve(values.docs);
  const nav = parseNav(readFileSync(values.mkdocs, 'utf8'));
  const titles = navTitles(nav);
  const files = new Map(listMarkdownFiles(docsRoot).map((file) => [file, readFileSync(insideDocs(docsRoot, file), 'utf8')]));
  const fixups = values.fixups ? JSON.parse(readFileSync(values.fixups, 'utf8')) : [];
  const fixed = applyFixups(files, fixups);
  console.error(`convert: ${files.size} files, ${fixups.length} fixups applied`);

  const stats = {nestedList: 0, listNotParagraph: 0, sites: []};
  const changed = [];
  const imports = {};
  for (const [file, content] of fixed) {
    const {text, imports: used} = convertFile(content, {file, stats});
    if (used.size > 0) {
      imports[file] = [...used].sort();
    }
    if (text !== files.get(file)) {
      changed.push(file);
      if (!values.check) {
        writeFileSync(insideDocs(docsRoot, file), text, 'utf8');
      }
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
    };
    writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (values.check) {
    for (const file of changed) {
      console.error(`would change: ${file}`);
    }
    console.error(`convert --check: ${changed.length} file(s) would change`);
    return changed.length > 0 ? 1 : 0;
  }
  console.error(`convert: ${changed.length} file(s) written`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`convert: ${error.message}`);
    process.exitCode = 2;
  }
}
