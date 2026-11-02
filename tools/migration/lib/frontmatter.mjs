/**
 * Front matter handling (spec §3 pass 1).
 *
 * MkDocs strips a leading YAML block delimited by `---` lines (trailing blanks allowed). The only
 * key in the corpus is `template:`, which maps to Docusaurus front matter. Output keys are written
 * in a fixed order and every string is JSON-quoted (valid YAML), so the result is deterministic.
 */
import * as yaml from 'js-yaml';

/** A front matter problem, with the 1-based file line it was found on. */
export class FrontMatterError extends Error {
  /**
   * @param {string} message What is wrong.
   * @param {number} line 1-based line in the file.
   */
  constructor(message, line) {
    super(message);
    this.name = 'FrontMatterError';
    this.line = line;
  }
}

/** Same pattern MkDocs 1.1 (`mkdocs.utils.meta`) uses to find the YAML block. */
const FRONT_MATTER = /^-{3}[ \t]*\n([\s\S]*?\n)(?:\.{3}|-{3})[ \t]*\n/;

/** Keys written first, in this order; any other key follows in sorted order. */
const KEY_ORDER = ['title', 'hide_title', 'displayed_sidebar', 'hide_table_of_contents', 'hide_markdown_actions', 'wide'];

/** MkDocs template (by file name) -> Docusaurus front matter it becomes. */
const TEMPLATE_MAP = new Map([
  ['single-column.html', {displayed_sidebar: null, hide_table_of_contents: true, hide_markdown_actions: true}],
  ['redoc.html', {wide: true, hide_markdown_actions: true}],
]);

/**
 * Split a file into its YAML front matter and body.
 *
 * @param {string} src Whole file content (LF line endings).
 * @returns {{data: object|null, body: string}} Parsed front matter (null when absent) and the rest.
 * @throws {FrontMatterError} When the YAML is malformed or not a mapping (with the file line).
 */
export function splitFrontMatter(src) {
  const match = FRONT_MATTER.exec(src);
  if (!match) {
    return {data: null, body: src};
  }
  let data;
  try {
    data = yaml.load(match[1], {schema: yaml.JSON_SCHEMA}) ?? {};
  } catch (error) {
    // js-yaml marks are 0-based within the YAML text, which starts on line 2 of the file.
    throw new FrontMatterError(`invalid YAML: ${error.reason ?? 'parse error'}`, (error.mark?.line ?? -1) + 2);
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new FrontMatterError('front matter must be a YAML mapping', 1);
  }
  return {data, body: src.slice(match[0].length)};
}

/**
 * Serialise one front matter value as a YAML scalar.
 *
 * @param {string} key Key (for the error message).
 * @param {unknown} value Scalar value.
 * @returns {string} YAML text for the value.
 * @throws {Error} For non-scalar values, which the converter never produces.
 */
function yamlScalar(key, value) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  throw new Error(`front matter key ${key} has an unsupported value type`);
}

/**
 * Join front matter and body back into one file.
 *
 * @param {object|null} data Front matter mapping; null or empty means "no front matter".
 * @param {string} body File body.
 * @returns {string} The file content.
 */
export function joinFrontMatter(data, body) {
  if (!data || Object.keys(data).length === 0) {
    return body;
  }
  const keys = Object.keys(data);
  const ordered = [
    ...KEY_ORDER.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !KEY_ORDER.includes(key)).sort(),
  ];
  const lines = ordered.map((key) => `${key}: ${yamlScalar(key, data[key])}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/**
 * Replace the MkDocs `template:` key with the equivalent Docusaurus keys (pass 1).
 *
 * @param {object} data Front matter mapping.
 * @returns {object} A new mapping without `template`.
 * @throws {Error} For a template the site does not know.
 */
export function mapTemplate(data) {
  if (!data || !Object.hasOwn(data, 'template')) {
    return {...data};
  }
  const {template, ...rest} = data;
  const name = String(template).split('/').pop();
  const mapped = TEMPLATE_MAP.get(name);
  if (!mapped) {
    throw new Error(`Unknown MkDocs template: ${String(template).slice(0, 80)}`);
  }
  return {...rest, ...mapped};
}
