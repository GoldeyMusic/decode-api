/**
 * costTracker.js — calcul du coût d'une analyse + insertion en base.
 *
 * Utilisé à la fin de runDiagnosticPhase (api/analyze.js). Lit les
 * accumulators de gemini.js et claude.js (tokens captés en cours
 * d'analyse), additionne avec les forfaits Fadr/infra, et insère
 * une ligne dans la table Supabase `analysis_cost_logs`.
 *
 * Les tarifs ci-dessous sont des CONSTANTES — David peut les
 * ajuster ici quand il aura ses vrais chiffres de facturation.
 * Tarifs en EUR par 1M tokens (conversion approximative depuis
 * les tarifs USD officiels au 1 USD ≈ 0,92 EUR).
 *
 * Ne plante pas le pipeline si l'insertion échoue : on log
 * l'erreur et on continue (le coût manqué = bug à investiguer
 * mais l'analyse de l'utilisateur reste réussie).
 */

const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────
// TARIFS (€ par 1M tokens). Ajuste-les ici si nécessaire.
// Sources :
//   Gemini : https://ai.google.dev/pricing (octobre 2025)
//   Claude : https://www.anthropic.com/pricing (Sonnet 4.6)
//
// Conversion USD → EUR à 0.92.
// ─────────────────────────────────────────────────────────────

// Gemini 2.5 Flash (modèle prioritaire dans gemini.js — fallback Pro)
// $0.075 / 1M input audio, $0.30 / 1M output → en EUR
const GEMINI_FLASH_IN_EUR_PER_1M = 0.069;
const GEMINI_FLASH_OUT_EUR_PER_1M = 0.276;

// Gemini 2.5 Pro (fallback) — plus cher
// $1.25 / 1M input audio, $5.00 / 1M output
const GEMINI_PRO_IN_EUR_PER_1M = 1.15;
const GEMINI_PRO_OUT_EUR_PER_1M = 4.60;

// Claude Sonnet 4.6 — $3 / 1M input, $15 / 1M output
const CLAUDE_SONNET_IN_EUR_PER_1M = 2.76;
const CLAUDE_SONNET_OUT_EUR_PER_1M = 13.80;

// ─────────────────────────────────────────────────────────────
// FORFAITS AJUSTABLES — David, tu modifies ces constantes
// quand tu auras tes vrais chiffres de facturation Fadr et
// d'infra (Vercel + Supabase storage/egress amorti par analyse).
// ─────────────────────────────────────────────────────────────
const FADR_COST_EUR = 0.20;   // Forfait par analyse Fadr (estimation)
const INFRA_COST_EUR = 0.02;  // Forfait Vercel + Supabase amorti

// Marge de sécurité ajoutée au total (en %), pour absorber les
// imprécisions d'estimation (audio token count Gemini, surcoûts retry, …).
// 0 = pas de marge, 0.10 = +10 %.
const SAFETY_MARGIN_PCT = 0.05;

// ─────────────────────────────────────────────────────────────
// computeCosts — calcule le breakdown € pour une analyse.
//
// Args :
//   geminiUsage = { promptTokenCount, candidatesTokenCount, model? }
//   claudeUsage = { input_tokens, output_tokens, model? }
//   fadrCalled  = bool (true si Fadr a tourné, false si KO/skip)
//
// Return : { gemini_eur, claude_eur, fadr_eur, infra_eur, total_eur }
// ─────────────────────────────────────────────────────────────
function computeCosts({ geminiUsage = {}, claudeUsage = {}, fadrCalled = true }) {
  const gIn = Number(geminiUsage.promptTokenCount || 0);
  const gOut = Number(geminiUsage.candidatesTokenCount || 0);
  // Si on a utilisé un modèle Pro plutôt que Flash, on calcule au tarif Pro.
  const isPro = (geminiUsage.model || '').toLowerCase().includes('pro');
  const gInRate = isPro ? GEMINI_PRO_IN_EUR_PER_1M : GEMINI_FLASH_IN_EUR_PER_1M;
  const gOutRate = isPro ? GEMINI_PRO_OUT_EUR_PER_1M : GEMINI_FLASH_OUT_EUR_PER_1M;
  const gemini_eur = (gIn * gInRate + gOut * gOutRate) / 1_000_000;

  const cIn = Number(claudeUsage.input_tokens || 0);
  const cOut = Number(claudeUsage.output_tokens || 0);
  const claude_eur = (cIn * CLAUDE_SONNET_IN_EUR_PER_1M + cOut * CLAUDE_SONNET_OUT_EUR_PER_1M) / 1_000_000;

  const fadr_eur = fadrCalled ? FADR_COST_EUR : 0;
  const infra_eur = INFRA_COST_EUR;

  const subtotal = gemini_eur + claude_eur + fadr_eur + infra_eur;
  const total_eur = subtotal * (1 + SAFETY_MARGIN_PCT);

  return {
    gemini_eur: round4(gemini_eur),
    claude_eur: round4(claude_eur),
    fadr_eur: round4(fadr_eur),
    infra_eur: round4(infra_eur),
    total_eur: round4(total_eur),
  };
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

// ─────────────────────────────────────────────────────────────
// Supabase client (service_role) — lazy init.
// ─────────────────────────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[costTracker] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — logging disabled');
    return null;
  }
  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

// ─────────────────────────────────────────────────────────────
// logAnalysisCost — INSERT une ligne dans analysis_cost_logs.
//
// Args :
//   userId           : uuid du user (peut être null pour analyses anonymes)
//   jobId            : id éphémère du job côté backend (string)
//   audioDurationSec : durée du fichier audio (number)
//   geminiUsage      : { promptTokenCount, candidatesTokenCount, model? }
//   claudeUsage      : { input_tokens, output_tokens, model? }
//   fadrCalled       : bool
//
// Return : la ligne insérée, ou null si erreur (loggée).
// Ne throw JAMAIS — ne doit pas casser le pipeline d'analyse.
// ─────────────────────────────────────────────────────────────
async function logAnalysisCost({
  userId = null,
  jobId = null,
  audioDurationSec = null,
  geminiUsage = {},
  claudeUsage = {},
  fadrCalled = true,
}) {
  try {
    const sb = getSupabase();
    if (!sb) return null;

    const costs = computeCosts({ geminiUsage, claudeUsage, fadrCalled });

    const row = {
      user_id: userId || null,
      job_id: jobId || null,
      audio_duration_sec: audioDurationSec || null,
      gemini_in_tokens: Number(geminiUsage.promptTokenCount || 0),
      gemini_out_tokens: Number(geminiUsage.candidatesTokenCount || 0),
      claude_in_tokens: Number(claudeUsage.input_tokens || 0),
      claude_out_tokens: Number(claudeUsage.output_tokens || 0),
      gemini_eur: costs.gemini_eur,
      claude_eur: costs.claude_eur,
      fadr_eur: costs.fadr_eur,
      infra_eur: costs.infra_eur,
      total_eur: costs.total_eur,
      gemini_model: geminiUsage.model || null,
      claude_model: claudeUsage.model || null,
      fadr_called: !!fadrCalled,
    };

    const { data, error } = await sb
      .from('analysis_cost_logs')
      .insert(row)
      .select()
      .single();

    if (error) {
      console.error('[costTracker] insert error:', error.message);
      return null;
    }
    console.log(`[costTracker] logged: ${costs.total_eur} € (gemini ${costs.gemini_eur} + claude ${costs.claude_eur} + fadr ${costs.fadr_eur} + infra ${costs.infra_eur})`);
    return data;
  } catch (err) {
    console.error('[costTracker] unexpected error:', err.message);
    return null;
  }
}

module.exports = { computeCosts, logAnalysisCost };
