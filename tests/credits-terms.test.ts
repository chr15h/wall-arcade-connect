// The client-side purchase guard must accept exactly the pack that the deployed credit group sells, and nothing else.
// (Regression: the upstream template hard-coded 0.01 USDC; our group sells 50 credits for 10 USDC = 10000000 atomic.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSavedPurchase, quoteTokenIsUsdc, EXPECTED_PACK_CREDITS, EXPECTED_PACK_PRICE_ATOMIC, formatPrice, packPriceLabel, packTermsMatch } from '../src/shell/credits.js';

const group = JSON.parse(readFileSync(new URL('../deploy/credit-group.json', import.meta.url), 'utf8'));

test('the expected pack is the one the deployed credit group sells', () => {
  assert.equal(EXPECTED_PACK_PRICE_ATOMIC, group.packPriceAtomic);
  assert.equal(EXPECTED_PACK_PRICE_ATOMIC, '10000000');         // 10 USDC (6 decimals), the organizer's decision 2026-10-17
  assert.equal(EXPECTED_PACK_CREDITS, group.packCredits);
  assert.equal(group.chainId, 1);
  assert.equal(group.currency, 'USDC');
  assert.equal(group.tokenAddress, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
});

test('packTermsMatch accepts the deployed pack only', () => {
  assert.equal(packTermsMatch({ packPriceAtomic: '10000000', packCredits: 50 }), true);
  assert.equal(packTermsMatch({ packPriceAtomic: '100000', packCredits: 10 }), false);    // the previous pack (0.10 USDC)
  assert.equal(packTermsMatch({ packPriceAtomic: '10000', packCredits: 10 }), false);     // the template's $0.01
  assert.equal(packTermsMatch({ packPriceAtomic: '100000000', packCredits: 50 }), false); // ten times too expensive
  assert.equal(packTermsMatch({ packPriceAtomic: '10000000', packCredits: 49 }), false);
  assert.equal(packTermsMatch({ packPriceAtomic: '10000000', packCredits: 500 }), false);
  assert.equal(packTermsMatch({ packPriceAtomic: '010000000', packCredits: 50 }), false); // exact string match, no coercion
  assert.equal(packTermsMatch({ packPriceAtomic: '10000000.0', packCredits: 50 }), false);
  assert.equal(packTermsMatch({ packPriceAtomic: '', packCredits: 10 }), false);
});

test('no purchase guard in the shell still hard-codes the template price', () => {
  const source = readFileSync(new URL('../src/shell/credits.ts', import.meta.url), 'utf8');
  assert.equal(/['"]10000['"]/.test(source), false, 'a literal 10000 (0.01 USDC) is back in credits.ts');
  assert.equal(/\$0\.01/.test(source), false, 'a $0.01 message is back in credits.ts');
});

test('prices are shown with cents: 100000 atomic is $0.10 USDC', () => {
  assert.equal(formatPrice('100000'), '$0.10 USDC');
  assert.equal(formatPrice('10000'), '$0.01 USDC');
  assert.equal(formatPrice('1000000'), '$1.00 USDC');
  assert.equal(formatPrice('1500000'), '$1.50 USDC');
  assert.equal(formatPrice('123456'), '$0.123456 USDC');
  assert.equal(formatPrice('0'), '$0.00 USDC');
  assert.equal(formatPrice('abc'), 'an amount shown by the wallet');
});

test('both purchase guards go through packTermsMatch', () => {
  const source = readFileSync(new URL('../src/shell/credits.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/!packTermsMatch\(quote\)/g) ?? []).length, 2, 'quote creation and the pay-time re-check must both call packTermsMatch');
});

test('the price players read comes from the guard: 10 USDC', () => {
  assert.equal(packPriceLabel(), '10 USDC');
});

// Regression 2026-10-20: Studio's quote now says `currency` + `tokenAddress` (SDK 0.11); the old SDK refused it with
// "purchase.usdcAddress expected string, received undefined" and no new player could buy.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
test('the purchase guard reads the current quote shape: currency USDC + canonical token only', () => {
  assert.equal(quoteTokenIsUsdc({ currency: 'USDC', tokenAddress: USDC }), true);
  assert.equal(quoteTokenIsUsdc({ currency: 'USDC', tokenAddress: USDC.toUpperCase().replace('0X', '0x') }), true);
  assert.equal(quoteTokenIsUsdc({ currency: 'ETH', tokenAddress: null }), false);
  assert.equal(quoteTokenIsUsdc({ currency: 'USDC', tokenAddress: '0x0000000000000000000000000000000000000001' }), false);
  assert.equal(quoteTokenIsUsdc({ tokenAddress: USDC }), false);
});

test('purchases saved before the change (usdcAddress) still load, normalised to currency + tokenAddress', () => {
  const base = { id: 'p', accountId: 'a', paymentConfigId: 'c', chainId: 1, address: '0x1111111111111111111111111111111111111111',
    treasuryAddress: '0xb6ede0158e1792ed25e1367edeec05a824d7c9ad', packPriceAtomic: '10000000', packCredits: 50, minBlock: '1',
    createdAt: '2026-10-18T00:00:00Z', expiresAt: '2026-10-18T00:10:00Z', transactionHash: null, creditedAt: null };
  const legacy = parseSavedPurchase({ purchase: { ...base, usdcAddress: USDC }, confirmPayment: true });
  assert.equal(legacy.purchase.currency, 'USDC');
  assert.equal(legacy.purchase.tokenAddress, USDC);
  assert.equal('usdcAddress' in legacy.purchase, false);
  const current = parseSavedPurchase({ purchase: { ...base, currency: 'USDC', tokenAddress: USDC } });
  assert.equal(quoteTokenIsUsdc(current.purchase), true);
});
