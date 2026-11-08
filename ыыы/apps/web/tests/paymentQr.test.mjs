import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentQrTarget } from '../src/lib/paymentQr.ts';

const form = 'https://pay.platega.io/sbp-qr/p/test-order?merchantId=test-merchant';
const bank = 'https://qr.nspk.ru/test-order?sum=103&cur=RUB';

test('a newly created payment has a usable form QR before the bank issues an NSPK URI', () => {
  assert.deepEqual(paymentQrTarget(null, form), { url: form, kind: 'payment-link' });
  assert.deepEqual(paymentQrTarget('', form), { url: form, kind: 'payment-link' });
});
test('a bank URI replaces the form QR and is labelled for bank scanners', () => {
  assert.deepEqual(paymentQrTarget(bank, form), { url: bank, kind: 'sbp' });
});
test('unsafe bank values never become bank QR codes', () => {
  for (const value of ['javascript:alert(1)', 'https://qr.nspk.ru.evil.test/a', 'https://user@qr.nspk.ru/a', 'https://qr.nspk.ru:444/a', bank + '#fragment', bank + '\n', 'https://qr.nspk.ru/']) {
    assert.deepEqual(paymentQrTarget(value, form), { url: form, kind: 'payment-link' });
  }
});
test('a missing or untrusted form produces no fabricated payment code', () => {
  for (const value of [null, '', 'http://pay.platega.io/a', 'https://pay.platega.io.evil.test/a', 'https://user:pass@pay.platega.io/a', 'https://pay.platega.io/', form + '\n']) {
    assert.equal(paymentQrTarget(null, value), null);
  }
});
