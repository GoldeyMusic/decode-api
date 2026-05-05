/**
 * lib/auth.js — middleware d'authentification Bearer JWT Supabase.
 *
 * Tous les endpoints (sauf /billing/webhook qui est signé Stripe et
 * /billing/health qui est public) doivent passer par requireAuth.
 *
 * À l'arrivée :
 *   req.user.id     → uuid du user authentifié (à utiliser comme source
 *                     unique de vérité pour les IDs côté backend, JAMAIS
 *                     req.body.userId / req.query.userId qui sont
 *                     attaquables).
 *   req.user.email  → email vérifié par Supabase Auth.
 *
 * Le client Supabase est créé avec la ANON_KEY + le bearer du user pour
 * que `auth.getUser()` valide la signature du JWT côté Supabase. On ne
 * fait PAS confiance au token sans vérification.
 */

const { createClient } = require('@supabase/supabase-js');

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.auth.getUser();
    if (error || !data?.user) return res.status(401).json({ error: 'unauthorized' });
    req.user = data.user;
    next();
  } catch (e) {
    console.error('[auth] requireAuth error:', e.message);
    return res.status(401).json({ error: 'unauthorized' });
  }
}

/**
 * Helper pour vérifier qu'un path Storage appartient bien au user
 * authentifié. Préfixé par tmp/ ou non (ex. "userId/file.mp3"
 * vs "tmp/userId/file.mp3").
 */
function userOwnsPath(user, path, { allowTmpPrefix = true } = {}) {
  if (!user?.id || typeof path !== 'string') return false;
  // Préfixe attendu : "<user.id>/" OU "tmp/<user.id>/"
  if (path.startsWith(user.id + '/')) return true;
  if (allowTmpPrefix && path.startsWith('tmp/' + user.id + '/')) return true;
  return false;
}

module.exports = { requireAuth, userOwnsPath };
