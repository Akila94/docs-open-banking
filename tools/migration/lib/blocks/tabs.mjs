/**
 * Legacy superfences `tab="X"` groups -> `<Tabs>`/`<TabItem>` (spec §3 pass 4).
 */

/**
 * Slug a tab label for the `value` prop: lower-case ASCII letters and digits joined by `-`.
 *
 * @param {string} label Tab label.
 * @returns {string} Slug (`tab` when nothing usable remains).
 */
export function slugTabLabel(label) {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'tab' : slug;
}

/**
 * Unique `value`s for one group: duplicates get `-2`, `-3`, … in order.
 *
 * @param {string[]} labels Labels in tab order.
 * @returns {string[]} Values in the same order.
 */
export function tabValues(labels) {
  const used = new Set();
  return labels.map((label) => {
    const base = slugTabLabel(label);
    let value = base;
    for (let counter = 2; used.has(value); counter += 1) {
      value = `${base}-${counter}`;
    }
    used.add(value);
    return value;
  });
}

/**
 * Quote a JSX attribute value without escapes (JSX strings have none).
 *
 * @param {string} value Attribute value.
 * @returns {string} `"value"`, `'value'` or a `{"…"}` expression when both quotes occur.
 */
export function jsxAttributeValue(value) {
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `{${JSON.stringify(value)}}`;
}

/**
 * The label superfences shows for a tab: the `tab` value, else the language, else `Tab N`.
 *
 * @param {{tab: string}} fence Stashed tab fence (`tab` already falls back to the language).
 * @param {number} index 0-based position in the group.
 * @returns {string} Label.
 */
export function tabLabel(fence, index) {
  return fence.tab !== '' ? fence.tab : `Tab ${index + 1}`;
}
