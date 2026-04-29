/**
 * lib/credits.js — helpers Supabase pour la mécanique de crédits.
 *
 * Ces helpers sont utilisés :
 *   - par api/billing.js (webhook Stripe) → crédite après paiement
 *   - par api/analyze.js (pipeline) → débit au start, refund à l'erreur
 *
 * Ils s'appuient sur les tables user_credits + credit_events
 * (migration 016) et utilisent le service_role pour bypasser RLS.
 *
 * Pendant la phase test, le pipeline analyze.js peut choisir de NE PAS
 * débiter (toggle MONETIZATION_ENABLED). Stripe webhooks, eux, sont
 * actifs dès qu'ils reçoivent un événement.
 */

const { createClient } = require('@supabase/supabase-js');

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — credits helpers unavailable');
  }
  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

/**
 * Lit le solde courant. Crée la ligne user_credits si absente (avec 0).
 * Renvoie un Number (balance) ou null si user_id invalide.
 */
async function getBalance(userId) {
  if (!userId) return null;
  const sb = getSupabase();
  // INSERT idempotent (UNIQUE user_id) avec balance=0 si pas encore là.
  await sb.from('user_credits')
    .upsert({ user_id: userId, balance_remaining: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });
  const { data, error } = await sb
    .from('user_credits')
    .select('balance_remaining')
    .eq('user_id', userId)
    .single();
  if (error) {
    console.error('[credits] getBalance failed:', error.message);
    return null;
  }
  return Number(data?.balance_remaining || 0);
}

/**
 * Applique un mouvement de crédit atomique : INSERT credit_events +
 * UPDATE user_credits.balance_remaining. Retourne le nouveau solde.
 *
 * Args :
 *   userId          : uuid du user
 *   delta           : signé (+N pour crédit, -N pour débit)
 *   reason          : enum (cf. migration 016 contrainte CHECK)
 *   jobId           : analyse associée (optionnel)
 *   stripeEventId   : id event Stripe pour idempotence webhook (UNIQUE)
 *   notes           : texte libre
 *
 * Si stripeEventId est déjà connu, on no-op et on renvoie le balance courant
 * (idempotence — Stripe peut retry).
 */
async function applyCreditDelta({ userId, delta, reason, jobId = null, stripeEventId = null, notes = null }) {
  if (!userId) throw new Error('userId required');
  if (!Number.isFinite(delta) || delta === 0) throw new Error('delta must be a non-zero number');
  if (!reason) throw new Error('reason required');

  const sb = getSupabase();

  // Idempotence pour webhooks Stripe : si l'event est déjà loggé, no-op.
  if (stripeEventId) {
    const { data: existing } = await sb
      .from('credit_events')
      .select('id')
      .eq('stripe_event_id', stripeEventId)
      .maybeSingle();
    if (existing) {
      console.log(`[credits] event ${stripeEventId} already processed, skipping`);
      return await getBalance(userId);
    }
  }

  // Insère l'event d'audit.
  const { error: evErr } = await sb.from('credit_events').insert({
    user_id: userId,
    delta,
    reason,
    job_id: jobId,
    stripe_event_id: stripeEventId,
    notes,
  });
  if (evErr) {
    console.error('[credits] insert event failed:', evErr.message);
    throw new Error(`credit_event insert failed: ${evErr.message}`);
  }

  // S'assure qu'une ligne user_credits existe, puis UPDATE atomique.
  await sb.from('user_credits')
    .upsert({ user_id: userId, balance_remaining: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });

  // UPDATE atomique : balance := balance + delta. Postgres gère le verrou.
  // On utilise une RPC SQL pour éviter un read-then-write race.
  const { data, error: upErr } = await sb.rpc('apply_credit_delta_internal', {
    target_user_id: userId,
    delta_value: delta,
  });
  if (upErr) {
    console.error('[credits] apply_credit_delta_internal failed:', upErr.message);
    throw new Error(`balance update failed: ${upErr.message}`);
  }
  const newBalance = Number(data || 0);
  console.log(`[credits] ${userId} ${delta >= 0 ? '+' : ''}${delta} (${reason}) → ${newBalance}`);
  return newBalance;
}

module.exports = {
  getBalance,
  applyCreditDelta,
};
