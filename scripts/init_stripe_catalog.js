#!/usr/bin/env node
/**
 * scripts/init_stripe_catalog.js
 *
 * Crée (ou met à jour) les 4 produits + prices Stripe pour Versions :
 *   - 2 packs one-shot (pack_1, pack_5)
 *   - 2 abos mensuels (sub_indie, sub_pro)
 *
 * Catalogue révisé 2026-04-29 (Piste A) : pack_10 / pack_25 / pack_50 retirés.
 * Pour archiver les anciens prices côté Stripe : `node scripts/archive_legacy_packs.js`.
 *
 * Idempotent : si un product existe déjà avec le même metadata.plan_key,
 * on l'utilise au lieu d'en créer un nouveau (évite les doublons en cas
 * de re-run). Les prices, eux, sont créés à chaque run avec un nouveau
 * Price ID Stripe — c'est la convention Stripe (les prices sont immuables).
 *
 * Usage :
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/init_stripe_catalog.js
 *
 * Sortie :
 *   - Une liste de variables d'env Vite à copier dans .env du front
 *     (et dans Vercel pour la prod)
 *   - Récap créé / mis à jour
 *
 * IMPORTANT :
 *   - Lance d'abord en TEST MODE (sk_test_...) pour valider.
 *   - Pour la prod, relance avec sk_live_... (les Price IDs seront différents).
 */

const Stripe = require('stripe');

// ─── Catalogue à synchroniser avec versions-app/src/constants/plans.js ───
const PACKS = [
  { key: 'pack_1',  name: 'Versions — 1 analyse',   price_eur: 4.99,   credits: 1 },
  { key: 'pack_5',  name: 'Versions — 5 analyses',  price_eur: 19.99,  credits: 5 },
];
const SUBSCRIPTIONS = [
  { key: 'sub_indie', name: 'Versions — Abo Indie', price_eur: 14.99, credits: 12 },
  { key: 'sub_pro',   name: 'Versions — Abo Pro',   price_eur: 29.99, credits: 30 },
];

const KEY_TO_ENV = {
  pack_1:    'VITE_STRIPE_PRICE_PACK_1',
  pack_5:    'VITE_STRIPE_PRICE_PACK_5',
  sub_indie: 'VITE_STRIPE_PRICE_SUB_INDIE',
  sub_pro:   'VITE_STRIPE_PRICE_SUB_PRO',
};

(async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('STRIPE_SECRET_KEY missing.');
    console.error('Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/init_stripe_catalog.js');
    process.exit(1);
  }
  const stripe = new Stripe(key, { appInfo: { name: 'Versions init script', version: '1.0.0' } });

  const isTest = key.startsWith('sk_test_');
  console.log(`\n→ Mode : ${isTest ? 'TEST' : 'LIVE'}\n`);

  const envLines = [];

  // ── Packs ────
  for (const p of PACKS) {
    const product = await getOrCreateProduct(stripe, p);
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(p.price_eur * 100),
      currency: 'eur',
      metadata: {
        plan_key: p.key,
        credits: String(p.credits),
      },
      nickname: `${p.name} — one-shot`,
    });
    console.log(`✓ ${p.key.padEnd(10)} → ${price.id}`);
    envLines.push(`${KEY_TO_ENV[p.key]}=${price.id}`);
  }

  // ── Abos ────
  for (const sub of SUBSCRIPTIONS) {
    const product = await getOrCreateProduct(stripe, sub);
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(sub.price_eur * 100),
      currency: 'eur',
      recurring: { interval: 'month' },
      metadata: {
        plan_key: sub.key,
        credits: String(sub.credits),
      },
      nickname: `${sub.name} — monthly`,
    });
    console.log(`✓ ${sub.key.padEnd(10)} → ${price.id}`);
    envLines.push(`${KEY_TO_ENV[sub.key]}=${price.id}`);
  }

  // ── Sortie ────
  console.log('\n=== Variables d\'env à copier ===');
  console.log('# Versions-app (.env local + Vercel) :');
  for (const line of envLines) console.log(line);
  console.log('\n=== Étapes restantes ===');
  console.log('1. Colle les VITE_STRIPE_PRICE_* dans versions-app/.env (et Vercel env vars).');
  console.log('2. Crée le webhook Stripe (dashboard) → endpoint https://<decode-api>/api/billing/webhook');
  console.log('   Events à écouter : checkout.session.completed, invoice.paid, customer.subscription.deleted');
  console.log('3. Copie le Webhook signing secret (whsec_...) → STRIPE_WEBHOOK_SECRET sur decode-api.');
  console.log('4. Set STRIPE_SECRET_KEY (sk_test_...) côté decode-api.');
  console.log('\nTerminé.\n');
})().catch((err) => {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});

// Cherche un product existant par metadata.plan_key (idempotence du re-run).
// Si trouvé, met à jour son name. Sinon, le crée.
async function getOrCreateProduct(stripe, plan) {
  // Stripe permet de filtrer products par metadata via search (latest API)
  const search = await stripe.products.search({
    query: `metadata['plan_key']:'${plan.key}' AND active:'true'`,
    limit: 1,
  });
  if (search.data.length > 0) {
    const found = search.data[0];
    if (found.name !== plan.name) {
      await stripe.products.update(found.id, { name: plan.name });
    }
    return found;
  }
  return await stripe.products.create({
    name: plan.name,
    metadata: { plan_key: plan.key, credits: String(plan.credits) },
  });
}
