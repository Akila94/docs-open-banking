/**
 * MDX comments (`{/* … *\/}`), shared by the block emitter (HTML comment blocks, `[comment]` lines)
 * and the HTML -> JSX serializer (comments inside raw HTML).
 */

/** Thrown when a comment cannot be expressed as an MDX comment. */
export class MdxCommentError extends Error {}

/**
 * Wrap comment text in an MDX comment, keeping it verbatim except that `*\/` is written as `*\\/`.
 *
 * @param {string} inner Comment content (without `<!--`/`-->`).
 * @returns {string} `{/*inner*\/}`.
 * @throws {MdxCommentError} When the braces do not balance (MDX's expression scanner needs that).
 */
export function mdxCommentText(inner) {
  const escaped = inner.replaceAll('*/', '*\\/');
  const opens = (escaped.match(/\{/g) ?? []).length;
  const closes = (escaped.match(/\}/g) ?? []).length;
  if (opens !== closes) {
    throw new MdxCommentError('comment text has unbalanced braces, which MDX cannot parse');
  }
  return `{/*${escaped}*/}`;
}

/**
 * Inverse of `mdxCommentText` for the converter's own output.
 *
 * @param {string} inner Text between `{/*` and `*\/}`.
 * @returns {string} The original comment content.
 */
export function mdxCommentContent(inner) {
  return inner.replaceAll('*\\/', '*/');
}
