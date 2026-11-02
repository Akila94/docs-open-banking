/**
 * Parsers used by the inline passes.
 *
 * - `parseMarkdown`: CommonMark + GFM + directives (the converter's view of the block passes'
 *   output). HTML *flow* is disabled: outside the raw blocks the block passes already isolated
 *   (masked here), HTML only ever occurs inside paragraphs in Python-Markdown, where the text
 *   between tags is Markdown, so it must be tokenised as inline HTML. Link destinations carry their
 *   exact source offsets (`node.data.destination`) so they can be spliced.
 * - `parseMdx`: the MDX parse `@mdx-js/mdx` performs (remark-parse + remark-mdx + GFM + directives),
 *   used to see headings exactly as Docusaurus does.
 */
import {fromMarkdown} from 'mdast-util-from-markdown';
import {gfm} from 'micromark-extension-gfm';
import {gfmFromMarkdown} from 'mdast-util-gfm';
import {directive} from 'micromark-extension-directive';
import {directiveFromMarkdown} from 'mdast-util-directive';
import {createProcessor} from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';
import remarkDirective from 'remark-directive';

/** Record where a link/image destination sits in the source (same semantics as the default). */
const destinationPositions = {
  exit: {
    resourceDestinationString(token) {
      const url = this.resume();
      const node = this.stack[this.stack.length - 1];
      node.url = url;
      node.data = {...node.data, destination: {start: token.start.offset, end: token.end.offset}};
    },
  },
};

/** The converter's own JSX style objects (`style={{…}}`), which CommonMark cannot tokenise as HTML. */
const OWN_STYLE_OBJECT = /=\{\{[^{}\n]*\}\}/g;

/**
 * Blank the given ranges (newlines kept, so offsets and lines are unchanged) and make the
 * converter's own `style={{…}}` attributes tokenisable as HTML attributes of the same length.
 *
 * @param {string} text Source.
 * @param {Array<{start: number, end: number}>} ranges Character ranges to blank.
 * @returns {string} Text with identical offsets.
 */
export function maskForParsing(text, ranges) {
  let masked = text.replace(OWN_STYLE_OBJECT, (match) => `="${'x'.repeat(match.length - 3)}"`);
  for (const {start, end} of ranges) {
    masked = masked.slice(0, start) + masked.slice(start, end).replace(/[^\n]/g, ' ') + masked.slice(end);
  }
  return masked;
}

/**
 * Parse Markdown the way the inline passes see it.
 *
 * @param {string} text Masked source.
 * @returns {object} mdast root (positions with offsets).
 */
export function parseMarkdown(text) {
  return fromMarkdown(text, {
    extensions: [gfm(), directive(), {disable: {null: ['htmlFlow']}}],
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown(), destinationPositions],
  });
}

const mdxProcessor = createProcessor({remarkPlugins: [remarkGfm, remarkDirective]});

/**
 * Parse MDX exactly as `@mdx-js/mdx` does (no transforms).
 *
 * @param {string} text MDX source.
 * @returns {object} mdast root.
 * @throws {Error} The MDX parse error (with `line`/`column`).
 */
export function parseMdx(text) {
  return mdxProcessor.parse(text);
}
