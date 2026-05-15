/**
 * api/_internal.js — endpoints appelés par Supabase Database Webhooks.
 *
 * Routes :
 *   POST /api/internal/notify-signup    → email ops "Nouvel inscrit"
 *   POST /api/internal/notify-deletion  → email ops "Compte supprimé"
 *   POST /api/internal/notify-feedback  → email ops "Nouvel avis testeur"
 *
 * Auth :
 *   Header `X-Notify-Secret` comparé à process.env.INTERNAL_NOTIFY_SECRET.
 *   Sans secret configuré côté Railway, on renvoie 500 (fail-closed) — sinon
 *   n'importe qui pourrait spammer la boîte ops avec de faux events.
 *
 * Payload Supabase Database Webhook (cf. doc Supabase) :
 *   {
 *     type: 'INSERT' | 'UPDATE' | 'DELETE',
 *     table: 'users' | 'feedback' | ...,
 *     schema: 'auth' | 'public' | ...,
 *     record:     { id, ...colonnes... },  // INSERT/UPDATE
 *     old_record: { id, ...colonnes... },  // DELETE/UPDATE
 *   }
 *
 * Ces routes ne sont PAS gated par requireAuth (elles sont appelées
 * server-to-server par Supabase, pas par un user authentifié). Elles sont
 * gated par le shared secret en header.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { notifyOps, renderOpsEmail } = require('../lib/notifyOps');

const router = express.Router();

// Client admin pour résoudre user_id → email sur les events feedback
// (le payload INSERT public.feedback ne contient que user_id, pas l'email).
// Lazy : on ne crée le client que si la route en a besoin et si la
// SERVICE_ROLE_KEY est configurée.
function getAdminClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── Auth shared secret ─────────────────────────────────────
function requireSecret(req, res, next) {
  const got = req.headers['x-notify-secret'];
  const want = process.env.INTERNAL_NOTIFY_SECRET;
  if (!want) {
    console.error('[internal] INTERNAL_NOTIFY_SECRET not configured on Railway');
    return res.status(500).json({ error: 'secret_not_configured' });
  }
  if (!got || got !== want) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────
// /api/internal/rag-debug — DIAGNOSTIC TEMPORAIRE (à retirer)
//
// Vérifie en live :
//   - le commit déployé (constante DEPLOY_MARKER)
//   - la présence des env vars OPENAI_API_KEY + SUPABASE_URL
//   - le chargement du module lib/rag
//   - une recherche RAG réelle avec un listening de test
//
// Protégé par ?secret=… hardcodé. Placée AVANT router.use(requireSecret)
// pour bypasser le header X-Notify-Secret (qu'on ne connaît pas côté curl).
// À retirer après diagnostic.
// ─────────────────────────────────────────────────────────────
const DEPLOY_MARKER = 'rag-fix-f685eb6';
let _ragModule = null;
try { _ragModule = require('../lib/rag'); } catch (_) { /* ignore */ }

router.get('/rag-debug', async (req, res) => {
  if (req.query.secret !== 'temp-rag-diag-2026-05-15') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const out = {
    deploy_marker: DEPLOY_MARKER,
    openai_key_present: !!process.env.OPENAI_API_KEY,
    supabase_url_present: !!process.env.SUPABASE_URL,
    supabase_anon_key_present: !!process.env.SUPABASE_ANON_KEY,
    supabase_service_role_present: !!process.env.SUPABASE_SERVICE_ROLE,
    rag_module_loaded: !!(_ragModule && _ragModule.retrievePureMixContext),
  };

  if (_ragModule?.retrievePureMixContext) {
    try {
      const testListening = {
        impression: 'EQ classique ou dynamique ? Un mix electronique dense avec un sub puissant et une voix bien presente',
        a_travailler: ['EQ classique ou dynamique ?', 'clarte des mediums', 'sub un peu mou'],
        points_forts: ['voix bien posee', 'spatial soigne'],
        espace: 'large stereo',
        dynamique: 'compressee',
        couleur: 'chaude',
        mood: 'nostalgique',
      };
      const minSim = req.query.min_sim !== undefined
        ? Number(req.query.min_sim)
        : 0.25;
      const chunks = await _ragModule.retrievePureMixContext(testListening, { minSimilarity: minSim, matchCount: 6 });
      out.min_similarity_used = minSim;
      out.chunks_count = chunks?.length || 0;
      out.sample_chunks = (chunks || []).slice(0, 6).map(c => ({
        category: c.category,
        source_file: c.source_file,
        similarity: c.similarity,
        content_preview: (c.content || '').slice(0, 160),
      }));
    } catch (err) {
      out.rag_error = err.message;
      out.rag_stack = (err.stack || '').split('\n').slice(0, 6).join('\n');
    }
  }

  return res.json(out);
});

router.use(requireSecret);

// ─── POST /notify-signup ────────────────────────────────────
router.post('/notify-signup', async (req, res) => {
  try {
    const { type, record } = req.body || {};
    if (type !== 'INSERT' || !record?.id) {
      return res.status(400).json({ error: 'unexpected_payload' });
    }

    const email = record.email || '—';
    const userId = record.id;
    // raw_app_meta_data.provider : 'email' | 'google' | etc.
    const provider = record.raw_app_meta_data?.provider || 'email';
    const providerLabel = provider === 'email' ? 'Email + mot de passe' : `OAuth ${provider}`;
    const createdAt = record.created_at || new Date().toISOString();
    const confirmed = !!record.email_confirmed_at;

    await notifyOps({
      subject: `[Versions] Nouvel inscrit · ${email}`,
      html: renderOpsEmail({
        title: 'Nouvel inscrit',
        intro: `${email} vient de créer un compte sur Versions.`,
        rows: [
          { label: 'Email', value: email },
          { label: 'Inscription via', value: providerLabel },
          { label: 'Email confirmé', value: confirmed ? 'Oui' : 'Pas encore' },
          { label: 'User ID', value: userId },
          { label: 'Date', value: typeof createdAt === 'string' ? createdAt.slice(0, 16).replace('T', ' ') + ' UTC' : '—' },
        ],
      }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[internal/notify-signup] failed:', err.message, err.stack);
    res.status(500).json({ error: 'handler_failed' });
  }
});

// ─── POST /notify-deletion ──────────────────────────────────
router.post('/notify-deletion', async (req, res) => {
  try {
    const { type, old_record } = req.body || {};
    if (type !== 'DELETE' || !old_record?.id) {
      return res.status(400).json({ error: 'unexpected_payload' });
    }

    const email = old_record.email || '—';
    const userId = old_record.id;
    const createdAt = old_record.created_at;

    await notifyOps({
      subject: `[Versions] Compte supprimé · ${email}`,
      html: renderOpsEmail({
        title: 'Compte supprimé',
        intro: `${email} a supprimé son compte Versions. Toutes ses données ont été purgées (RPC delete_my_account).`,
        rows: [
          { label: 'Email', value: email },
          { label: 'User ID', value: userId },
          { label: 'Compte créé le', value: typeof createdAt === 'string' ? createdAt.slice(0, 10) : '—' },
          { label: 'Suppression le', value: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' },
        ],
      }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[internal/notify-deletion] failed:', err.message, err.stack);
    res.status(500).json({ error: 'handler_failed' });
  }
});

// ─── POST /notify-feedback ──────────────────────────────────
// Déclenché par un Supabase Database Webhook sur INSERT public.feedback.
// On envoie un mail ops résumant l'avis (NPS + verbatims + contexte).
//
// Le payload Supabase ne contient que la ligne feedback (user_id, NPS,
// verbatims, version_id, track_id, route, locale, user_agent, created_at).
// Pour avoir l'email du testeur dans le mail, on résout user_id via
// l'Admin API (auth.admin.getUserById). Si la résolution échoue (clé
// SERVICE_ROLE absente, user déjà supprimé, etc.), on tombe sur l'UUID
// — la notif part quand même, on ne bloque pas pour un email manquant.
router.post('/notify-feedback', async (req, res) => {
  try {
    const { type, record } = req.body || {};
    if (type !== 'INSERT' || !record?.id || !record?.user_id) {
      return res.status(400).json({ error: 'unexpected_payload' });
    }

    // Résolution email du testeur (best-effort).
    let userEmail = null;
    const admin = getAdminClient();
    if (admin) {
      try {
        const { data, error } = await admin.auth.admin.getUserById(record.user_id);
        if (!error && data?.user?.email) userEmail = data.user.email;
      } catch (e) {
        console.warn('[internal/notify-feedback] getUserById failed:', e.message);
      }
    }

    // NPS color-coded comme dans la modale (FR : 0-6 détracteur, 7-8 passif, 9-10 promoteur).
    const nps = record.nps;
    let npsLabel = '—';
    if (nps !== null && nps !== undefined) {
      const seg = nps <= 6 ? 'détracteur' : (nps <= 8 ? 'passif' : 'promoteur');
      npsLabel = `${nps}/10 (${seg})`;
    }

    // Date du retour, format lisible UTC (cohérent avec les autres mails ops).
    const createdAt = record.created_at || new Date().toISOString();
    const dateLabel = typeof createdAt === 'string'
      ? createdAt.slice(0, 16).replace('T', ' ') + ' UTC'
      : '—';

    // Subject orienté tri Gmail : NPS d'abord pour repérer rapido les
    // détracteurs sans ouvrir, puis email du testeur (ou UUID en fallback).
    const subjectWho = userEmail || `user ${record.user_id.slice(0, 8)}…`;
    const subjectNps = nps !== null && nps !== undefined ? `NPS ${nps}/10` : 'sans NPS';
    const subject = `[Versions] Nouvel avis · ${subjectNps} · ${subjectWho}`;

    // Métadonnées courtes en table label/value, puis verbatims en blocks
    // pour qu'ils respirent en multi-ligne (cf. renderOpsEmail).
    const rows = [
      { label: 'Testeur', value: userEmail || record.user_id },
      { label: 'NPS', value: npsLabel },
      { label: 'Route', value: record.route || '—' },
      { label: 'Version (fiche)', value: record.version_id || null },
      { label: 'Track', value: record.track_id || null },
      { label: 'Locale', value: record.locale || null },
      { label: 'User agent', value: record.user_agent || null },
      { label: 'App version', value: record.app_version || null },
      { label: 'Date', value: dateLabel },
    ];

    // Libellés alignés sur les questions de FeedbackModal pour qu'on
    // retrouve d'un coup d'œil de quoi parle chaque verbatim.
    const blocks = [
      { label: 'Surprise · ce qui a marqué', body: record.surprise },
      { label: 'Friction · pas compris / inutile', body: record.friction },
      { label: 'Pay willingness · prix juste', body: record.paywill },
      { label: 'One-liner · pitch à un pote', body: record.oneliner },
      { label: 'Priorité · à changer en 1er', body: record.priority },
    ];

    await notifyOps({
      subject,
      html: renderOpsEmail({
        title: 'Nouvel avis testeur',
        intro: userEmail
          ? `${userEmail} a laissé un retour via la modale feedback.`
          : `Un testeur a laissé un retour via la modale feedback.`,
        rows,
        blocks,
      }),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[internal/notify-feedback] failed:', err.message, err.stack);
    res.status(500).json({ error: 'handler_failed' });
  }
});

module.exports = router;
