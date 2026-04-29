/**
 * api/billing.js — endpoints Stripe (checkout + webhook).
 *
 * Routes exposées :
 *   POST /api/billing/checkout   → crée une Stripe Checkout Session, renvoie { url }
 *   POST /api/billing/webhook    → traite les events Stripe (signed)
 *   GET  /api/billing/health     → ping (vérifie env vars)
 *
 * Auth :
 *   - /checkout : Bearer JWT Supabase (vérifié via supabase.auth.getUser).
 *   - /webhook  : signature Stripe (header `stripe-signature`).
 *
 * Crédit appliqué :
 *   - Pack one-shot   : event `checkout.session.completed` (mode=payment)
 *                       → +N crédits (N = price.metadata.credits)
 *   - Abo mensuel     : event `invoice.paid` (chaque mois)
 *                       → +N crédits (idem) + maj user_credits.monthly_grant
 *   - Abo annulé      : event `customer.subscription.deleted`
 *                       → reset monthly_grant à 0 (les crédits restants restent)
 *
 * Tous les events sont aussi loggés dans `revenue_logs` pour le suivi business.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { getStripe } = require('../lib/stripe');
const { applyCreditDelta } = require('../lib/credits');

const router = express.Router();

// ─── Health check ─────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    webhook: !!process.env.STRIPE_WEBHOOK_SECRET,
    supabase: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
});

// ─── Auth helper : vérifie le JWT Supabase ────────────────────
async function getAuthedUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

// ─── POST /checkout — crée une Stripe Checkout Session ────────
//
// Body JSON attendu : { planKey, priceId, mode: 'payment' | 'subscription' }
// Réponse : { url: 'https://checkout.stripe.com/...' }
router.post('/checkout', express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const user = await getAuthedUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { planKey, priceId, mode } = req.body || {};
    if (!planKey || typeof planKey !== 'string') {
      return res.status(400).json({ error: 'planKey required' });
    }
    if (!priceId || typeof priceId !== 'string' || !priceId.startsWith('price_')) {
      return res.status(400).json({ error: 'priceId required (price_...)' });
    }
    const checkoutMode = mode === 'subscription' ? 'subscription' : 'payment';

    const stripe = getStripe();

    // success_url : retour direct dashboard. Le webhook crédite l'user
    // en arrière-plan. Pas besoin de query params : la sidebar montrera
    // le nouveau solde au prochain refresh / login.
    const APP_BASE = process.env.APP_BASE_URL || 'https://versions.studio';
    const session = await stripe.checkout.sessions.create({
      mode: checkoutMode,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      // Email pré-rempli à partir du compte Supabase
      customer_email: user.email,
      // Metadata sur la Session : retrouvé dans tous les events
      metadata: {
        user_id: user.id,
        plan_key: planKey,
      },
      // Pour les abos, propage aussi la metadata sur la subscription
      // (sinon les events `invoice.paid` mensuels n'auront pas user_id)
      subscription_data: checkoutMode === 'subscription' ? {
        metadata: { user_id: user.id, plan_key: planKey },
      } : undefined,
      // Pour les paiements one-shot, on précise aussi la PaymentIntent metadata
      payment_intent_data: checkoutMode === 'payment' ? {
        metadata: { user_id: user.id, plan_key: planKey },
      } : undefined,
      success_url: `${APP_BASE}/#/dashboard`,
      cancel_url: `${APP_BASE}/#/pricing`,
      // Locale FR par défaut (l'app est principalement francophone)
      locale: 'fr',
      // Permet à Stripe de proposer/sauvegarder la TVA
      automatic_tax: { enabled: false }, // À activer une fois le compte Stripe certifié pour l'EU VAT
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing/checkout] error:', err.message, err.stack);
    return res.status(500).json({ error: 'checkout_failed', message: err.message });
  }
});

// ─── POST /webhook — traite les events Stripe ─────────────────
//
// IMPORTANT : ce handler attend du raw body (express.raw) pour
// la vérification de signature. Le middleware raw est attaché
// directement à la route. Le router est monté AVANT
// express.json() global dans server.js — sinon le body est
// déjà parsé en JSON et la signature ne matche plus.
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig) return res.status(400).send('missing stripe-signature header');
  if (!secret) {
    console.error('[billing/webhook] STRIPE_WEBHOOK_SECRET missing');
    return res.status(500).send('webhook secret not configured');
  }

  const stripe = getStripe();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[billing/webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleStripeEvent(event, stripe);
    return res.json({ received: true });
  } catch (err) {
    console.error('[billing/webhook] handler threw:', err.message, err.stack);
    // 500 → Stripe va retry. Idempotence garantie via stripe_event_id UNIQUE.
    return res.status(500).json({ error: 'handler_failed', message: err.message });
  }
});

async function handleStripeEvent(event, stripe) {
  console.log(`[billing/webhook] event: ${event.type} (${event.id})`);

  // Pack one-shot finalisé → on crédite N analyses
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.mode !== 'payment') {
      // Les abos sont gérés via invoice.paid pour avoir le N à chaque renouvellement.
      console.log('[billing/webhook] checkout.session.completed (subscription) → no-op (abo handled via invoice.paid)');
      return;
    }
    await handlePackPurchase({ session, stripe, eventId: event.id });
    return;
  }

  // Abo : facturation mensuelle (initiale OU renouvellement) → crédite N
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    if (!invoice.subscription) return; // facture orpheline, ignore
    await handleSubscriptionInvoice({ invoice, stripe, eventId: event.id });
    return;
  }

  // Abo résilié : on remet monthly_grant à 0 (pas de débit, juste arrêt du flux mensuel)
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const userId = sub?.metadata?.user_id;
    if (!userId) {
      console.warn('[billing/webhook] subscription.deleted without metadata.user_id, skip');
      return;
    }
    const sb = getSbServiceRole();
    await sb.from('user_credits')
      .update({ monthly_grant: 0, monthly_renews_at: null, stripe_subscription_id: null })
      .eq('user_id', userId);
    await logRevenueEvent({
      sb,
      userId,
      source: 'stripe',
      product: sub?.metadata?.plan_key || 'subscription',
      amount_eur: 0,
      net_eur: 0,
      stripe_id: sub.id || null,
      stripe_event_id: event.id,
      notes: 'subscription deleted',
    });
    return;
  }

  // Sinon : on log juste pour audit (utile en dev)
  console.log(`[billing/webhook] event ${event.type} ignored (not handled)`);
}

// ─── Pack one-shot : crédite N analyses + log revenue_logs ────
async function handlePackPurchase({ session, stripe, eventId }) {
  const userId = session?.metadata?.user_id;
  const planKey = session?.metadata?.plan_key;
  if (!userId) throw new Error('checkout.session.completed missing metadata.user_id');

  // Récupère le line_item pour lire `price.metadata.credits`
  const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5, expand: ['data.price'] });
  const li = items.data?.[0];
  const credits = parseInt(li?.price?.metadata?.credits || '0', 10);
  if (!credits || credits <= 0) {
    throw new Error(`pack purchase has no credits metadata (planKey=${planKey})`);
  }

  await applyCreditDelta({
    userId,
    delta: credits,
    reason: 'purchase_pack',
    stripeEventId: eventId,
    notes: `Pack ${planKey} - session ${session.id}`,
  });

  // Log revenue : on récupère le VRAI net via balance_transaction.fee de Stripe
  // (pas une approximation 1.5%+0.25). Frais réels selon provenance carte :
  // EEE 1,5% + 0,25 €, UK 2,5%, hors-EU ~3,25% + frais devise.
  const sb = getSbServiceRole();
  const grossEur = (session.amount_total || 0) / 100;
  const { netEur } = await fetchStripeNet({ stripe, paymentIntentId: session.payment_intent, grossEur });
  await logRevenueEvent({
    sb, userId,
    source: 'stripe',
    product: planKey,
    amount_eur: grossEur,
    net_eur: netEur,
    stripe_id: session.payment_intent || session.id || null,
    stripe_event_id: eventId,
    notes: `Pack ${planKey} (${credits} credits)`,
  });
}

// ─── Récupère le vrai montant net via balance_transaction.fee Stripe ────
// Pour PaymentIntent (one-shot) : passer paymentIntentId.
// Pour Invoice (abo)            : passer chargeId directement.
// Fallback : si la BT n'est pas encore disponible, approximation EEE 1.5%+0.25€.
async function fetchStripeNet({ stripe, paymentIntentId = null, chargeId = null, grossEur }) {
  try {
    let charge = null;
    if (paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge.balance_transaction'],
      });
      charge = pi?.latest_charge;
    } else if (chargeId) {
      charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
    }
    const bt = charge?.balance_transaction;
    if (bt && typeof bt.fee === 'number') {
      const feeEur = bt.fee / 100;
      const netEur = Math.round((grossEur - feeEur) * 100) / 100;
      return { netEur, feeEur, source: 'stripe_balance_transaction' };
    }
  } catch (e) {
    console.warn('[billing] fetchStripeNet failed, using approximation:', e.message);
  }
  // Fallback : approximation EEE
  const netApprox = grossEur > 0 ? Math.round((grossEur - (grossEur * 0.015 + 0.25)) * 100) / 100 : 0;
  return { netEur: netApprox, feeEur: grossEur - netApprox, source: 'approximation_eee' };
}

// ─── Abo : facture mensuelle → crédite + maj monthly_grant ────
async function handleSubscriptionInvoice({ invoice, stripe, eventId }) {
  const subscriptionId = invoice.subscription;
  // Récupère la subscription pour lire metadata.user_id
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
  const userId = sub?.metadata?.user_id;
  const planKey = sub?.metadata?.plan_key;
  if (!userId) throw new Error('invoice.paid subscription missing metadata.user_id');

  const item = sub?.items?.data?.[0];
  const credits = parseInt(item?.price?.metadata?.credits || '0', 10);
  if (!credits || credits <= 0) {
    throw new Error(`subscription has no credits metadata (planKey=${planKey})`);
  }

  // RESET du grant mensuel : les crédits abo non utilisés ne se cumulent pas.
  // Les crédits issus de packs (one-shot) survivent au reset car on ne les
  // touche pas dans l'algo : on calcule "abo restant = balance - extra_credits"
  // au moment du renouvellement, mais c'est complexe à tracer. Pour le MVP
  // on adopte une logique simple : à chaque renouvellement, on AJOUTE le
  // grant mensuel (les crédits abo non utilisés se cumulent). Ajustement
  // possible en V2 (reset propre via column "subscription_credits" séparée).
  // → décision 2026-04-29 avec David : "reset chaque mois (a)" pour abo,
  //   on NE LAISSE PAS les crédits non utilisés se cumuler. Implémentation :
  //   on log un event `subscription_reset` négatif si la prev period existait,
  //   puis un event `subscription_grant` positif.

  const sb = getSbServiceRole();

  // Récupère le grant précédent pour calculer le reset
  const { data: existing } = await sb
    .from('user_credits')
    .select('monthly_grant, balance_remaining, monthly_renews_at')
    .eq('user_id', userId)
    .maybeSingle();
  const prevGrant = Number(existing?.monthly_grant || 0);
  const prevBalance = Number(existing?.balance_remaining || 0);

  // Reset : on retire l'éventuel grant précédent du balance (ce qui ne consomme
  // que ce qui restait du grant abo, pas les packs achetés).
  // Limite : on ne descend jamais sous zéro.
  if (prevGrant > 0) {
    const resetDelta = -Math.min(prevGrant, prevBalance);
    if (resetDelta < 0) {
      await applyCreditDelta({
        userId,
        delta: resetDelta,
        reason: 'subscription_reset',
        stripeEventId: `${eventId}-reset`, // suffixe pour idempotence séparée
        notes: 'Reset crédits abo non utilisés',
      });
    }
  }

  // Grant : on ajoute la nouvelle enveloppe mensuelle
  await applyCreditDelta({
    userId,
    delta: credits,
    reason: 'subscription_grant',
    stripeEventId: eventId,
    notes: `Abo ${planKey} - renew (invoice ${invoice.id})`,
  });

  // Met à jour les méta abo sur user_credits
  const renewsAt = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
  await sb.from('user_credits')
    .update({
      monthly_grant: credits,
      monthly_renews_at: renewsAt,
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: invoice.customer || null,
    })
    .eq('user_id', userId);

  // Log revenue : récupère le VRAI net via balance_transaction.fee Stripe.
  const grossEur = (invoice.amount_paid || 0) / 100;
  const { netEur } = await fetchStripeNet({ stripe, chargeId: invoice.charge, grossEur });
  await logRevenueEvent({
    sb, userId,
    source: 'stripe',
    product: planKey,
    amount_eur: grossEur,
    net_eur: netEur,
    stripe_id: invoice.id || null,
    stripe_event_id: eventId,
    notes: `Abo ${planKey} renewal (invoice ${invoice.id}, ${credits} credits)`,
  });
}

// ─── Logging revenue_logs ─────────────────────────────────────
// Schéma cible (cf. migration 013 + 019) :
//   stripe_id        : charge_id ou invoice_id Stripe (corrélation dashboard)
//   stripe_event_id  : event_id qui a déclenché l'INSERT (UNIQUE, idempotence)
//   description      : texte libre
async function logRevenueEvent({ sb, userId, source, product, amount_eur, net_eur, stripe_event_id, stripe_id = null, notes }) {
  // Idempotence : si l'event est déjà loggé, no-op.
  if (stripe_event_id) {
    const { data: existing } = await sb
      .from('revenue_logs')
      .select('id')
      .eq('stripe_event_id', stripe_event_id)
      .maybeSingle();
    if (existing) return;
  }
  const { error } = await sb.from('revenue_logs').insert({
    user_id: userId,
    source,
    product,
    amount_eur,
    net_eur,
    stripe_id,
    stripe_event_id,
    description: notes || null,
  });
  if (error) console.error('[billing] revenue_logs insert failed:', error.message);
}

let _sbServiceRole = null;
function getSbServiceRole() {
  if (_sbServiceRole) return _sbServiceRole;
  _sbServiceRole = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return _sbServiceRole;
}

module.exports = router;
