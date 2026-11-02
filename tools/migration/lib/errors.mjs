/**
 * Error types shared by the migration converter.
 *
 * Messages are built only from file paths, line numbers and short excerpts of the documentation
 * source (public content); control characters are replaced so a crafted input cannot forge
 * extra lines in the CLI output.
 */

/**
 * Replace CR, LF and other control characters so a value is safe to embed in a one-line message.
 *
 * @param {string} value Any text.
 * @param {number} [maxLength=80] Maximum excerpt length.
 * @returns {string} A single-line excerpt.
 */
export function excerpt(value, maxLength = 80) {
  const singleLine = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}…` : singleLine;
}

/**
 * Raised when the block tokenizer meets input it cannot classify or would convert lossily.
 * The message always starts with `<file>:<line>: `.
 */
export class ConversionError extends Error {
  /**
   * @param {string} file Docs-relative path of the file being converted.
   * @param {number} line 1-based line number in the original file.
   * @param {string} message What is wrong and how to fix it (usually: add a fixup).
   */
  constructor(file, line, message) {
    super(`${file}:${line}: ${message}`);
    this.name = 'ConversionError';
    this.file = file;
    this.line = line;
  }
}
