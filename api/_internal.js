/**
 * api/_internal.js — endpoints appelés par Supabase Database Webhooks.
 *
 * Routes :
 *   POST /api/internal/notify-signup    → email ops "Nouvel inscrit"
 *   POST /api/internal/notify-deletion  → email ops "Compte supprimé"
 *
 * Auth :
 *   Header `X-Notify-Secret` comparé à process.env.INTERNAL_NOTIFY_SECRET.
 *   Sans secret configuré côté Railway, on renvoie 500 (fail-closed) — sinon
 *   n'importe qui pourrait spammer la boîte ops avec de faux events.
 *
 * Payload Supabase Database Webhook (cf. doc Supabase) :
 *   {
 *     type: 'INSERT' | 'UPDATE' | 'DELETE',
 *     table: 'users',
 *     schema: 'auth',
 *     record:     { id, email, created_at, raw_app_meta_data, ... },  // INSERT/UPDATE
 *     old_record: { id, email, created_at, ... },                      // DELETE/UPDATE
 *   }
 *
 * Ces routes ne sont PAS gated par requireAuth (elles sont appelées
 * server-to-server par Supabase, pas par un user authentifié). Elles sont
 * gated par le shared secret en header.
 */

const express = require('express');
const { notifyOps, renderOpsEmail } = require('../lib/notifyOps');

const router = express.Router();

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

module.exports = router;
