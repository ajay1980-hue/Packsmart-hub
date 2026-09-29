import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKSMART_EMAIL_BRAND, hasPacksmartFooter, renderPacksmartEmail } from '../lib/email-branding.mjs';

test('Packsmart email renderer appends canonical clickable branding', () => {
  const rendered = renderPacksmartEmail({ html: '<p>Hello</p>', text: 'Hello' });
  assert.match(rendered.html, /packsmart-email-footer:v1/);
  assert.ok(rendered.html.includes(PACKSMART_EMAIL_BRAND.bannerUrl));
  assert.ok(rendered.html.includes('https://packsmartsolutions.com/'));
  assert.ok(rendered.html.includes('linkedin.com/company/packsmart-solutions-ltd'));
  assert.ok(rendered.html.includes('instagram.com/packsmartsolutions'));
  assert.ok(rendered.html.includes('facebook.com/profile.php?id=61592667608867'));
  assert.ok(rendered.html.includes('tiktok.com/@packsmartsolutions'));
  assert.equal(hasPacksmartFooter(rendered.html), true);
});

test('Packsmart email renderer does not duplicate the HTML footer', () => {
  const first = renderPacksmartEmail({ html: '<p>Hello</p>', text: 'Hello' });
  const second = renderPacksmartEmail({ html: first.html, text: 'Hello' });
  assert.equal((second.html.match(/packsmart-email-footer:v1/g) || []).length, 1);
});
