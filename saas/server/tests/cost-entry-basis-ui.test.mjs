import test from 'node:test';
import assert from 'node:assert/strict';
import { costSourceHarness, selector, until } from './cost-source-ui-fixture.mjs';

const values = h => Object.fromEntries([...h.d.querySelectorAll('#economics-body .econ-input')].map(field => [field.dataset.field, field.value]));

test('cost basis help is available beside the table without changing recorded costs or authority', async t => {
  const h = await costSourceHarness(t);
  const before = { values: values(h), state: structuredClone(h.state), calls: h.calls.length };
  const guide = h.d.querySelector('#view-profit .cost-entry-guide');
  assert.equal(guide.open, false);
  assert.equal(guide.closest('.table-wrap'), null, 'guidance stays outside the horizontally scrolling table');
  assert.match(h.el('cost-entry-basis').textContent, /same basis as its displayed price/);
  for (const input of h.d.querySelectorAll('.money-input .econ-input')) {
    assert.equal(input.getAttribute('aria-describedby'), 'cost-entry-basis');
  }
  guide.open = true;
  h.d.querySelector('.cost-details').click();
  assert.match(guide.textContent, /Fictional example:/);
  assert.match(guide.textContent, /Do not multiply a cost again/);
  assert.match(guide.textContent, /unknown basis/);
  assert.match(h.d.querySelector('[data-field="boxQuantity"]').parentElement.textContent, /saleable SKU units/);
  assert.match(h.d.querySelector('[data-field="supplierDelivery"]').parentElement.textContent, /Inbound delivery/);
  assert.deepEqual(values(h), before.values);
  assert.deepEqual(h.state, before.state);
  assert.equal(h.calls.length, before.calls, 'opening guidance and supplier detail makes no API call');
  assert.equal(values(h).packing, '0');
  assert.equal(values(h).handling, '');
  assert.equal(values(h).supplierVatRecoverable, '');
});

test('cost save retains the existing SKU payload, decimal strings, zero and unknown values', async t => {
  const h = await costSourceHarness(t);
  Object.assign(h.bootstrap.economics[selector.sku], {
    supplierUnitCost: '0.3200', boxPrice: '6.40', boxQuantity: 20,
    supplierDelivery: null, supplierVatRate: null, supplierVatRecoverable: null,
    marginFloor: null, notes: 'Synthetic pack of 6; allocation remains unknown.'
  });
  await h.controls.reload({ migrate: false });
  const expected = values(h);
  const before = structuredClone(h.state);
  h.sourcePut = async (_route, options) => {
    assert.deepEqual(JSON.parse(options.body), { sku: selector.sku, economics: expected });
    return Response.json({ ok: true });
  };
  h.d.querySelector('.cost-entry-guide').open = true;
  h.d.querySelector('.save-economics').click();
  await until(() => h.sourceWrites().length === 1);
  await until(() => !h.d.querySelector('.save-economics').disabled);
  const saved = JSON.parse(h.sourceWrites()[0].body);
  assert.equal(saved.economics.landed, '4.2500');
  assert.equal(saved.economics.supplierUnitCost, '0.3200');
  assert.equal(saved.economics.boxQuantity, '20');
  assert.equal(saved.economics.packing, '0');
  for (const key of ['handling', 'supplierDelivery', 'supplierVatRate', 'supplierVatRecoverable', 'marginFloor']) assert.equal(saved.economics[key], '');
  assert.equal(Object.hasOwn(saved, 'sourceReview'), false);
  assert.equal(Object.hasOwn(saved.economics, 'price'), false);
  assert.deepEqual(h.state, before, 'synthetic transport does not change financial records or authority');
});
