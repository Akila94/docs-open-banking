/**
 * Heading slugs on both sides of the migration (spec §3 pass 12).
 *
 * - `mkdocsSlugify` / `mkdocsUnique`: exact ports of Python-Markdown 3.2.2
 *   `markdown.extensions.toc.slugify(value, '-')` and `unique(id, ids)`.
 * - `docusaurusSlug`: the stateful github-slugger 1.5.0 slugger that Docusaurus 3.10.2 wraps in
 *   `@docusaurus/utils` `createSlugger()` (lower-cased, `-1`, `-2`, … de-duplication).
 */
import GithubSlugger from 'github-slugger';

/** Python `\s` restricted to ASCII (the value is ASCII-only after the NFKD/ascii step). */
const PY_SPACE = '\\t\\n\\v\\f\\r \\x1c-\\x1f';
const NOT_WORD_SPACE_DASH = new RegExp(`[^A-Za-z0-9_${PY_SPACE}-]`, 'g');
const DASH_OR_SPACE_RUN = new RegExp(`[-${PY_SPACE}]+`, 'g');
const EDGE_SPACE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
/** `toc.IDCOUNT_RE`. */
const ID_COUNT = /^(.*)_([0-9]+)$/s;

/**
 * Port of `toc.slugify(value, '-')`: NFKD, drop non-ASCII, drop `[^\w\s-]`, strip, lower-case,
 * collapse runs of `-`/whitespace into one `-`.
 *
 * @param {string} text Heading text as Python-Markdown computes it.
 * @returns {string} The slug (possibly empty).
 */
export function mkdocsSlugify(text) {
  const ascii = text.normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
  const cleaned = ascii.replace(NOT_WORD_SPACE_DASH, '').replace(EDGE_SPACE, '').toLowerCase();
  return cleaned.replace(DASH_OR_SPACE_RUN, '-');
}

/**
 * Port of `toc.unique(id, ids)`: append `_1`, or increment an existing `_N`, until unused.
 * Adds the result to `seen`.
 *
 * @param {string} id Candidate id.
 * @param {Set<string>} seen Ids already used in the document (mutated).
 * @returns {string} A unique id.
 */
export function mkdocsUnique(id, seen) {
  let candidate = id;
  while (seen.has(candidate) || candidate === '') {
    const match = ID_COUNT.exec(candidate);
    candidate = match ? `${match[1]}_${Number.parseInt(match[2], 10) + 1}` : `${candidate}_1`;
  }
  seen.add(candidate);
  return candidate;
}

/**
 * Create a Docusaurus-equivalent stateful slugger.
 *
 * @returns {GithubSlugger} A fresh slugger.
 */
export function createDocusaurusSlugger() {
  return new GithubSlugger();
}

/**
 * Slug a heading text the way Docusaurus does (registers the slug in `slugger`).
 *
 * @param {string} text Heading text (`mdast-util-to-string` of the heading).
 * @param {GithubSlugger} slugger Per-document slugger (mutated).
 * @returns {string} The unique slug.
 */
export function docusaurusSlug(text, slugger) {
  return slugger.slug(text);
}

/**
 * The slug Docusaurus would give `text` next, without registering it.
 *
 * @param {string} text Heading text.
 * @param {GithubSlugger} slugger Per-document slugger (not mutated).
 * @returns {string} The slug `docusaurusSlug` would return.
 */
export function peekDocusaurusSlug(text, slugger) {
  const probe = new GithubSlugger();
  probe.occurrences = Object.assign(Object.create(null), slugger.occurrences);
  return probe.slug(text);
}
