import { DESCRIPTION_EDIT_SCHEMA } from '../lib/description-edit.mjs';
import { contentPilotFixture } from './content-pilot-test-fixture.mjs';
export const PARAGRAPH = '<p class="details">Synthetic grey mailing bags with <strong>old wording</strong>.</p>';
export const PREFIX = '<div class="product-copy">\r\n<h2>Grey mailing bags — synthetic fixture</h2>\n<p>Keep this introduction &amp; its spacing.</p>\n<!-- Retain this comment. -->\n';
export const SUFFIX = '\n<ul><li>Water-resistant outer layer</li><li><em>Self-seal</em> closure</li></ul>\n<p>Keep sizing, delivery and recycling details.</p>\n</div>';
export const REPLACEMENT = 'Approved synthetic wording & care <details>.\nSecond line: café 📦';
export const RESULT_PARAGRAPH = '<p class="details">Approved synthetic wording &amp; care &lt;details&gt;.<br>Second line: café 📦</p>';
export function descriptionInput() {
  return { schema: DESCRIPTION_EDIT_SCHEMA, productId: 'gid://shopify/Product/71', operation: 'product_content',
    baselineHtml: PREFIX + PARAGRAPH + SUFFIX, baselineUpdatedAt: '2026-10-14T12:00:00Z',
    paragraphHtml: PARAGRAPH, replacementText: REPLACEMENT, descriptionHtml: PREFIX + RESULT_PARAGRAPH + SUFFIX };
}
export const descriptionFixture = (options = {}) => contentPilotFixture({ family: 'manual-v1-policy', descriptionInput: descriptionInput(), ...options });
// Shared independent expected values for JS and the opt-in PostgreSQL proof.
export const paragraphCases = [
  { name: 'representative rich HTML', html: PREFIX + PARAGRAPH + SUFFIX, paragraph: PARAGRAPH, text: REPLACEMENT, expected: PREFIX + RESULT_PARAGRAPH + SUFFIX },
  { name: 'quoted angle bracket and uppercase tags', html: '<P data-x="<p>">Old <b>text</b></P><p>Keep</p>', paragraph: '<P data-x="<p>">Old <b>text</b></P>', text: 'New & <text>', expected: '<P data-x="<p>">New &amp; &lt;text&gt;</P><p>Keep</p>' },
  { name: 'duplicate paragraphs', html: '<p>Old</p><p>Old</p>', paragraph: '<p>Old</p>', text: 'New' },
  { name: 'comment is not a paragraph', html: '<!-- <p>Old</p> --><p>Keep</p>', paragraph: '<p>Old</p>', text: 'New' },
  { name: 'implicit paragraph close', html: '<p>Old<div>Block</div></p>', paragraph: '<p>Old<div>Block</div></p>', text: 'New' },
  { name: 'nested paragraphs', html: '<p><p>Old</p></p>', paragraph: '<p>Old</p>', text: 'New' },
  { name: 'raw script content', html: '<script>"<p>Old</p>"</script>', paragraph: '<p>Old</p>', text: 'New' },
  { name: 'foreign content', html: '<svg><p>Old</p></svg>', paragraph: '<p>Old</p>', text: 'New' },
  { name: 'unbalanced list', html: '<ul><li>First<li>Second</ul><p>Old</p>', paragraph: '<p>Old</p>', text: 'New' },
  { name: 'invalid list child', html: '<ul><p>Old</p></ul>', paragraph: '<p>Old</p>', text: 'New' },
  { name: 'unquoted attributes', html: '<p class=x>Old</p>', paragraph: '<p class=x>Old</p>', text: 'New' },
  { name: 'no change', html: '<p>Old</p>', paragraph: '<p>Old</p>', text: 'Old' },
  { name: 'Unicode offsets preserve combining and astral neighbors', html: '\u{1f642}<p>Old</p>e\u0301', paragraph: '<p>Old</p>', text: 'e\u0301 & \u{1f680}', expected: '\u{1f642}<p>e\u0301 &amp; \u{1f680}</p>e\u0301' },
  { name: 'exact 12000 UTF8 baseline bytes', html: '<p>x</p>' + '\u00e9'.repeat(5996), paragraph: '<p>x</p>', text: 'y', expected: '<p>y</p>' + '\u00e9'.repeat(5996) },
  { name: '12001 UTF8 baseline bytes refuse', html: '<p>x</p>' + '\u00e9'.repeat(5996) + 'a', paragraph: '<p>x</p>', text: 'y' },
  { name: 'exact 12000 result bytes', html: '<p>x</p>' + 'a'.repeat(11991), paragraph: '<p>x</p>', text: 'yy', expected: '<p>yy</p>' + 'a'.repeat(11991) },
  { name: '12001 result bytes refuse', html: '<p>x</p>' + 'a'.repeat(11991), paragraph: '<p>x</p>', text: 'yyy' },
  { name: 'exact 4000 UTF16 replacement units', html: '<p>x</p>', paragraph: '<p>x</p>', text: '\u{1f642}'.repeat(2000), expected: '<p>' + '\u{1f642}'.repeat(2000) + '</p>' },
  { name: '4002 UTF16 replacement units refuse', html: '<p>x</p>', paragraph: '<p>x</p>', text: '\u{1f642}'.repeat(2001) },
  { name: 'entity expansion within byte limit', html: '<p>x</p>', paragraph: '<p>x</p>', text: '&'.repeat(2398), expected: '<p>' + '&amp;'.repeat(2398) + '</p>' },
  { name: 'entity expansion over byte limit refuses', html: '<p>x</p>', paragraph: '<p>x</p>', text: '&'.repeat(2400) },
  { name: 'Unicode whitespace only refuses', html: '<p>x</p>', paragraph: '<p>x</p>', text: '\u00a0\ufeff\u2000' },
  { name: 'replacement tab refuses', html: '<p>x</p>', paragraph: '<p>x</p>', text: 'a\tb' },
  { name: 'depth 32 is accepted', html: '<div>'.repeat(31) + '<p>x</p>' + '</div>'.repeat(31), paragraph: '<p>x</p>', text: 'y', expected: '<div>'.repeat(31) + '<p>y</p>' + '</div>'.repeat(31) },
  { name: 'depth 33 refuses', html: '<div>'.repeat(32) + '<p>x</p>' + '</div>'.repeat(32), paragraph: '<p>x</p>', text: 'y' }
];
export const descriptionTimestampCases = [
  ['2024-02-29T23:59:59Z', true], ['2026-10-14T12:00:00.123Z', true],
  ['0001-01-01T00:00:00Z', true], ['9999-12-31T23:59:59.999Z', true],
  ['0000-01-01T00:00:00Z', false], ['2026-02-29T00:00:00Z', false],
  ['2026-02-30T00:00:00Z', false], ['2026-10-14T24:00:00Z', false],
  ['2026-10-14T12:00:60Z', false], ['2026-10-14T12:00:00+00:00', false],
  ['2026-10-14T12:00:00.1Z', false], ['2026-10-14T12:00:00.1234Z', false]
];
