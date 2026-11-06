import type {PrismTheme} from 'prism-react-renderer';

/**
 * Code block colours of the WSO2 Identity Platform documentation theme: one dark theme used in both
 * colour modes, so code reads the same on a light or a dark page.
 *
 * Values are taken from the theme of the WSO2 Identity Platform docs
 * (https://github.com/wso2/docs-is, en/theme/material/assets/css/theme.css, Apache-2.0).
 */
const prismTheme: PrismTheme = {
  plain: {color: '#d9d9de', backgroundColor: '#161618'},
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: '#47bfffb5', fontStyle: 'italic'}},
    {types: ['punctuation', 'operator'], style: {color: '#d9d9de'}},
    {types: ['keyword', 'selector', 'important', 'atrule', 'tag'], style: {color: '#4489ff'}},
    {types: ['string', 'char', 'attr-value', 'inserted'], style: {color: '#a0fbaa'}},
    {types: ['function', 'class-name', 'attr-name'], style: {color: '#ec9752'}},
    {types: ['number', 'boolean', 'deleted'], style: {color: '#d52a2a'}},
    {types: ['constant', 'symbol', 'property', 'builtin'], style: {color: '#00affe'}},
    {types: ['regex', 'entity', 'url', 'variable'], style: {color: '#ec9752'}},
  ],
};

export default prismTheme;
