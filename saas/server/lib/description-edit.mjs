// A deliberately bounded HTML subset. Never parse and reserialize the document:
// offsets select one explicit, unique paragraph and every surrounding byte stays.
import { types } from 'node:util';

export const DESCRIPTION_EDIT_SCHEMA = 'runvara-description-edit/v1';
export const DESCRIPTION_EDIT_KEYS = ['schema', 'productId', 'operation', 'baselineHtml', 'baselineUpdatedAt',
  'paragraphHtml', 'replacementText', 'descriptionHtml'];
export const DESCRIPTION_EDIT_QUERY = 'mutation RunvaraProductDescription($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }';
const fail = () => Object.assign(new Error('The exact paragraph edit could not be verified.'),
  { code: 'WRITE_DESCRIPTION_EDIT_INVALID', status: 409, definitive: true });
const inline = new Set(['a', 'span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup', 'code', 'br', 'img']);
const allowed = new Set([...inline, 'p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li']);
const voids = new Set(['br', 'img']);
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
export const isDescriptionEdit = value => Object.getOwnPropertyDescriptor(value || {}, 'schema')?.value === DESCRIPTION_EDIT_SCHEMA;

export function descriptionParagraphs(html) {
  if (typeof html !== 'string' || !html.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(html)
    || Buffer.byteLength(html) > 12000) throw fail();
  const stack = [], paragraphs = [];
  let offset = 0;
  while (offset < html.length) {
    if (html[offset] !== '<') {
      const end = html.indexOf('<', offset), text = html.slice(offset, end < 0 ? html.length : end);
      if (['ul', 'ol'].includes(stack.at(-1)?.name) && /\S/.test(text)) throw fail();
      offset += text.length; continue;
    }
    if (html.startsWith('<!--', offset)) {
      const end = html.indexOf('-->', offset + 4);
      if (end < 0 || html.slice(offset + 4, end).includes('--')) throw fail();
      offset = end + 3; continue;
    }
    const tail = html.slice(offset);
    const close = /^<\/([A-Za-z][A-Za-z0-9]*)[ \t\r\n]*>/.exec(tail);
    if (close) {
      const name = close[1].toLowerCase(), node = stack.pop();
      if (!node || node.name !== name) throw fail();
      if (name === 'p') paragraphs.push({ start: node.start, innerStart: node.innerStart, innerEnd: offset, end: offset + close[0].length });
      offset += close[0].length; continue;
    }
    // Quoted attributes only; raw text, foreign content, templates and implicit
    // closing tags are rejected instead of guessed. Quotes may contain '<'.
    const open = /^<([A-Za-z][A-Za-z0-9]*)(?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\r\n]*=[ \t\r\n]*(?:"[^"]*"|'[^']*'))?)*[ \t\r\n]*(\/?)>/.exec(tail);
    if (!open) throw fail();
    const name = open[1].toLowerCase(), parent = stack.at(-1)?.name;
    if (!allowed.has(name) || open[2] && !voids.has(name) || stack.length >= 32
      || stack.some(node => inline.has(node.name) || node.name === 'p' || /^h[1-6]$/.test(node.name)) && !inline.has(name)
      || ['ul', 'ol'].includes(parent) && name !== 'li'
      || name === 'li' && !['ul', 'ol'].includes(parent)
      || name === 'a' && stack.some(node => node.name === 'a')) throw fail();
    if (!voids.has(name)) stack.push({ name, start: offset, innerStart: offset + open[0].length });
    offset += open[0].length;
  }
  if (stack.length) throw fail();
  return paragraphs;
}

export function replaceDescriptionParagraph(baselineHtml, paragraphHtml, replacementText) {
  if (typeof paragraphHtml !== 'string' || typeof replacementText !== 'string' || !replacementText.trim()
    || replacementText.length > 4000 || !replacementText.isWellFormed() || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(replacementText)) throw fail();
  const matches = descriptionParagraphs(baselineHtml).filter(p => baselineHtml.slice(p.start, p.end) === paragraphHtml);
  if (matches.length !== 1) throw fail();
  const p = matches[0], result = baselineHtml.slice(0, p.innerStart) + escape(replacementText) + baselineHtml.slice(p.innerEnd);
  if (result === baselineHtml || Buffer.byteLength(result) > 12000) throw fail();
  return result;
}

export function descriptionEditPreimage(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.length !== DESCRIPTION_EDIT_KEYS.length || keys.some(key => !DESCRIPTION_EDIT_KEYS.includes(key))
    || DESCRIPTION_EDIT_KEYS.some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key], 'value'))) throw fail();
  const input = Object.fromEntries(DESCRIPTION_EDIT_KEYS.map(key => [key, fields[key].value]));
  if (input.schema !== DESCRIPTION_EDIT_SCHEMA || input.operation !== 'product_content'
    || typeof input.productId !== 'string' || input.productId.length > 100 || !/^gid:\/\/shopify\/Product\/\d+$/.test(input.productId)
    || typeof input.baselineUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(input.baselineUpdatedAt)
    || input.baselineUpdatedAt.startsWith('0000-')
    || !Number.isFinite(Date.parse(input.baselineUpdatedAt))
    || new Date(input.baselineUpdatedAt).toISOString() !== (input.baselineUpdatedAt.length === 20 ? input.baselineUpdatedAt.replace('Z', '.000Z') : input.baselineUpdatedAt)
    || input.descriptionHtml !== replaceDescriptionParagraph(input.baselineHtml, input.paragraphHtml, input.replacementText)) throw fail();
  return input;
}

export function descriptionEditMutation(input) {
  const checked = descriptionEditPreimage(input);
  return { query: DESCRIPTION_EDIT_QUERY, variables: { product: { id: checked.productId, descriptionHtml: checked.descriptionHtml } } };
}
