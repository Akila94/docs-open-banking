/**
 * Pass 0: exact, reviewed one-off source edits (`fixups/<branch>.json`).
 *
 * Each fixup is `{id, file, find, replace, reason}`. `find` must occur exactly once in `file`,
 * otherwise the run fails, so a fixup can never silently stop applying or apply twice.
 */
import {excerpt} from './errors.mjs';

/** Fixup ids are short kebab slugs; the verification allowlist references them as `fixup:<id>`. */
const FIXUP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Raised when a fixup is malformed or its `find` does not match exactly once. */
export class FixupError extends Error {
  /**
   * @param {string} id The fixup id (or `<unknown>`).
   * @param {string} message What went wrong.
   */
  constructor(id, message) {
    super(`fixup ${excerpt(id, 60)}: ${message}`);
    this.name = 'FixupError';
    this.id = id;
  }
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 *
 * @param {string} haystack Text to search.
 * @param {string} needle Non-empty search string.
 * @returns {number} Number of occurrences.
 */
function countOccurrences(haystack, needle) {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
    count += 1;
  }
  return count;
}

/**
 * Reject paths that are absolute or leave the docs directory, so a fixup can only touch docs files.
 *
 * @param {string} file Docs-relative POSIX path.
 * @returns {boolean} True when the path is a safe relative path.
 */
function isSafeRelativePath(file) {
  if (file.startsWith('/') || file.includes('\\') || file.includes('\0')) {
    return false;
  }
  return file.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Validate the shape of one fixup entry.
 *
 * @param {unknown} fixup Candidate entry.
 * @param {Set<string>} seenIds Ids already validated (for duplicate detection).
 * @throws {FixupError} When a field is missing, empty, of the wrong type or the id is reused.
 */
function validateFixup(fixup, seenIds) {
  const id = typeof fixup?.id === 'string' ? fixup.id : '<unknown>';
  if (!FIXUP_ID.test(id)) {
    throw new FixupError(id, 'id must be a kebab-case slug');
  }
  if (seenIds.has(id)) {
    throw new FixupError(id, 'duplicate id');
  }
  for (const key of ['file', 'find', 'replace', 'reason']) {
    if (typeof fixup[key] !== 'string') {
      throw new FixupError(id, `\`${key}\` must be a string`);
    }
  }
  if (fixup.find === '' || fixup.reason.trim() === '') {
    throw new FixupError(id, '`find` and `reason` must not be empty');
  }
  if (!isSafeRelativePath(fixup.file)) {
    throw new FixupError(id, '`file` must be a docs-relative path without `..`');
  }
  seenIds.add(id);
}

/**
 * Apply fixups to a set of files.
 *
 * @param {Map<string, string>} files Docs-relative path -> file content. Not mutated.
 * @param {Array<{id: string, file: string, find: string, replace: string, reason: string}>} fixups Entries, applied in order.
 * @returns {Map<string, string>} A new map with the fixups applied.
 * @throws {FixupError} Naming the fixup id, when an entry is malformed, targets an unknown file,
 *   or its `find` does not occur exactly once.
 */
export function applyFixups(files, fixups) {
  return applyFixupsWithLines(files, fixups).files;
}

/**
 * Apply fixups and report which lines of each fixed file came from a fixup's `replace` text.
 * The converter uses this to accept code whose indentation a fixup deliberately compensates.
 *
 * @param {Map<string, string>} files Docs-relative path -> file content. Not mutated.
 * @param {Array<{id: string, file: string, find: string, replace: string, reason: string}>} fixups Entries, applied in order.
 * @returns {{files: Map<string, string>, fixupLines: Map<string, Set<number>>}} Fixed files and, per
 *   fixed file, the 1-based line numbers (in the fixed content) produced by a fixup.
 * @throws {FixupError} As {@link applyFixups}.
 */
export function applyFixupsWithLines(files, fixups) {
  if (!Array.isArray(fixups)) {
    throw new FixupError('<unknown>', 'fixups must be an array');
  }
  const result = new Map(files);
  /** @type {Map<string, Array<{start: number, end: number}>>} character ranges in the current content */
  const ranges = new Map();
  const seenIds = new Set();
  for (const fixup of fixups) {
    validateFixup(fixup, seenIds);
    const content = result.get(fixup.file);
    if (content === undefined) {
      throw new FixupError(fixup.id, `file ${excerpt(fixup.file)} is not part of the docs set`);
    }
    const matches = countOccurrences(content, fixup.find);
    if (matches !== 1) {
      throw new FixupError(fixup.id, `\`find\` must match exactly once in ${fixup.file}, found ${matches}`);
    }
    const start = content.indexOf(fixup.find);
    const delta = fixup.replace.length - fixup.find.length;
    const fileRanges = (ranges.get(fixup.file) ?? [])
      .map((range) => (range.start >= start + fixup.find.length ? {start: range.start + delta, end: range.end + delta} : range));
    fileRanges.push({start, end: start + fixup.replace.length});
    ranges.set(fixup.file, fileRanges);
    result.set(fixup.file, content.slice(0, start) + fixup.replace + content.slice(start + fixup.find.length));
  }
  const fixupLines = new Map();
  for (const [file, fileRanges] of ranges) {
    const content = result.get(file);
    const lines = new Set();
    for (const {start, end} of fileRanges) {
      const first = content.slice(0, start).split('\n').length;
      const last = content.slice(0, Math.max(start, end - 1)).split('\n').length;
      for (let line = first; line <= last; line += 1) {
        lines.add(line);
      }
    }
    fixupLines.set(file, lines);
  }
  return {files: result, fixupLines};
}
