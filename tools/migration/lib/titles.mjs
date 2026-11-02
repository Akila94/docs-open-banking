/**
 * Page titles (spec §3 pass 13).
 *
 * MkDocs 1.1.2 (`Page._set_title`): the nav label when the page is in the nav (first occurrence; an
 * empty label counts), else `get_markdown_title` (the first non-blank line, when it starts with
 * `# `), else the file name with `-`/`_` as spaces, capitalised when all lower-case. Material shows
 * `{{ page.title | default(site_name, true) }}` as the synthetic h1 and only the site name as the
 * `<title>` of the home page. Docusaurus prints the site title alone when the doc title equals it
 * (`TitleFormatterFnDefault`), so the home page and empty labels get `title: <site_name>`.
 */
import path from 'node:path';

/**
 * Port of `mkdocs.utils.get_markdown_title`.
 *
 * @param {string} markdown Page body (front matter removed).
 * @returns {string|null} The title, or null.
 */
export function markdownTitle(markdown) {
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    return line.startsWith('# ') ? line.replace(/^[# ]+/, '') : null;
  }
  return null;
}

/**
 * MkDocs's title from a file name (`File.name`, then `_set_title`).
 *
 * @param {string} file Docs-relative path.
 * @returns {string} Title.
 */
export function filenameTitle(file) {
  const stem = path.posix.basename(file, '.md');
  const name = stem === 'README' ? 'index' : stem;
  const title = name.replaceAll('-', ' ').replaceAll('_', ' ');
  return title.toLowerCase() === title ? title.charAt(0).toUpperCase() + title.slice(1).toLowerCase() : title;
}

/**
 * The `title:` front matter value for a page.
 *
 * @param {string} file Docs-relative path.
 * @param {string} markdown Original (MkDocs) page body.
 * @param {{titles: Map<string, string>, siteName: string}} site Nav labels (empty labels kept) and site name.
 * @returns {string} Title.
 */
export function pageTitle(file, markdown, site) {
  if (file === 'index.md') {
    return site.siteName;
  }
  const title = site.titles.has(file) ? site.titles.get(file) : (markdownTitle(markdown) ?? filenameTitle(file));
  return title === '' ? site.siteName : title;
}
