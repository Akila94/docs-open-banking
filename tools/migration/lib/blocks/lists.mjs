/**
 * List block processors of the Python-Markdown emulation: `ListIndentProcessor`,
 * `OListProcessor` and `UListProcessor`, plus the `nestedList` author-intent rule (items indented
 * to the previous item's CommonMark content column nest instead of becoming siblings).
 *
 * The methods are mixed into `BlockParser.prototype` (parser.mjs) and use its `fail`, `state`,
 * `parseBlocks`, `parseChunk` and `recordIntent`.
 */
import {INDENT, TAB_LENGTH, looseDetab, withText, indentOf} from './lines.mjs';
import {lastChild} from './tree.mjs';

const OLIST_START = /^[ ]{0,3}\d+\.[ ]+(.*)/;
const ULIST_START = /^[ ]{0,3}[*+-][ ]+(.*)/;
const LIST_CHILD = /^[ ]{0,3}((\d+\.)|[*+-])[ ]+(.*)/;
const LIST_INDENTED = /^[ ]{4,7}((\d+\.)|[*+-])[ ]+.*/;

/**
 * CommonMark content column of a list item: marker indentation + marker width + one space.
 *
 * @param {{marker: string, markerLine: {text: string}}} item List item (node or get_items entry).
 * @returns {number} Column where the item's content starts.
 */
function contentColumn(item) {
  return indentOf(item.markerLine.text) + item.marker.length + 1;
}

/** Block parser methods for lists (mixed into `BlockParser.prototype`). */
export const listProcessorMethods = {
  /** `ListIndentProcessor` (priority 90): indented children of list items. */
  listIndent() {
    return {
      test: (parent, block) => block[0].text.startsWith(INDENT) && !this.isState('detabbed') &&
        (parent.type === 'item' || lastChild(parent)?.type === 'list'),
      run: (parent, blocks) => {
        let block = blocks.shift();
        const [level, sibling] = this.listLevel(parent, block);
        block = looseDetab(block, level);
        this.state.push('detabbed');
        if (parent.type === 'item') {
          const last = lastChild(parent);
          this.parseBlocks(last !== null && last.type === 'list' ? last : parent, [block]);
        } else if (sibling.type === 'item') {
          this.parseBlocks(sibling, [block]);
        } else if (sibling.children.length > 0 && lastChild(sibling).type === 'item') {
          this.parseChunk(lastChild(sibling), block);
        } else {
          this.fail(block[0], 'indented block would create a list item without a marker');
        }
        this.state.pop();
      },
    };
  },

  /**
   * `ListIndentProcessor.get_level`.
   *
   * @param {object} parent Container.
   * @param {Array<object>} block Block lines.
   * @returns {[number, object]} Indent level and the node that receives the block.
   */
  listLevel(parent, block) {
    const match = /^((?: {4})+)/.exec(block[0].text);
    const indentLevel = match ? match[1].length / TAB_LENGTH : 0;
    let level = this.isState('list') ? 1 : 0;
    let target = parent;
    while (indentLevel > level) {
      const child = lastChild(target);
      if (child === null || (child.type !== 'list' && child.type !== 'item')) {
        break;
      }
      if (child.type === 'list') {
        level += 1;
      }
      target = child;
    }
    return [level, target];
  },

  /** `OListProcessor` (priority 40). */
  orderedList() {
    return this.listProcessor(true, OLIST_START);
  },

  /** `UListProcessor` (priority 30). */
  unorderedList() {
    return this.listProcessor(false, ULIST_START);
  },

  /**
   * Shared list processor.
   *
   * @param {boolean} ordered Ordered list processor.
   * @param {RegExp} startPattern Pattern the block's first line must match.
   * @returns {{test: Function, run: Function}} Processor.
   */
  listProcessor(ordered, startPattern) {
    return {
      test: (_parent, block) => startPattern.test(block[0].text),
      run: (parent, blocks) => {
        const block = blocks.shift();
        const sibling = lastChild(parent);
        if (sibling !== null && sibling.type === 'list' && indentOf(block[0].text) >= contentColumn(lastChild(sibling))) {
          // Author intent: a blank-separated list indented to the last item's content column (2-3
          // spaces) nests under that item; Python-Markdown would continue the outer list with it.
          this.recordIntent('nestedList', block[0]);
          this.parseBlocks(lastChild(sibling), [block]);
          return;
        }
        const items = this.listItems(block, ordered);
        let list;
        if (sibling !== null && sibling.type === 'list') {
          if (sibling.ordered !== ordered) {
            this.fail(block[0], 'MkDocs merges this list into the preceding list of the other type; separate them with a fixup');
          }
          list = sibling;
          const first = items.shift();
          const item = this.newItem(first);
          list.children.push(item);
          this.state.push('looselist');
          this.parseBlocks(item, [first.lines]);
          this.state.pop();
        } else if (parent.type === 'list') {
          list = parent;
        } else {
          list = {type: 'list', ordered, children: []};
          parent.children.push(list);
        }
        this.state.push('list');
        for (const entry of items) {
          if (entry.indented) {
            const target = lastChild(list);
            if (target === null) {
              this.fail(entry.lines[0], 'indented list item without a parent item');
            }
            this.parseBlocks(target, [entry.lines]);
          } else {
            const item = this.newItem(entry);
            list.children.push(item);
            this.parseBlocks(item, [entry.lines]);
          }
        }
        this.state.pop();
      },
    };
  },

  /**
   * @param {{marker: string, markerLine: object}} entry Item entry from `listItems`.
   * @returns {object} Item node.
   */
  newItem(entry) {
    return {type: 'item', marker: entry.marker, markerLine: entry.markerLine, children: []};
  },

  /**
   * `OListProcessor.get_items`, plus nesting of items indented (2-3 spaces) to the CommonMark
   * content column of the previous item.
   *
   * @param {Array<object>} block Block lines.
   * @param {boolean} ordered Whether the list is ordered.
   * @returns {Array<{lines: object[], marker?: string, markerLine?: object, indented?: boolean}>} Items.
   */
  listItems(block, ordered) {
    const items = [];
    let lastTop = null;
    for (const original of block) {
      let line = original;
      let match = LIST_CHILD.exec(line.text);
      if (match && lastTop !== null && indentOf(line.text) >= contentColumn(lastTop)) {
        this.recordIntent('nestedList', line);
        line = withText(line, INDENT + line.text.trimStart());
        match = null;
      }
      if (match) {
        if (/^\d/.test(match[1]) !== ordered) {
          this.fail(line, 'Python-Markdown makes this a member of the surrounding list of the other type; fix it with a fixup');
        }
        lastTop = {marker: match[1], markerLine: line, lines: [withText(line, match[3])]};
        items.push(lastTop);
      } else if (LIST_INDENTED.test(line.text)) {
        const last = items[items.length - 1];
        if (last.indented) {
          last.lines.push(line);
        } else {
          items.push({indented: true, lines: [line]});
        }
      } else {
        items[items.length - 1].lines.push(line);
      }
    }
    return items;
  },
};
