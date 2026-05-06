/**
 * lib/deletionToken.js — tokens HMAC signés pour le flow de suppression de compte.
 *
 * Pas de dépendance externe : on utilise crypto natif Node 20.
 * Format : `<payloadB64>.<sigB64>` (similar to JWT sans le header).
 *   - payloadB64 = base64url(JSON.stringify({ user_id, email, locale, exp, iat }))
 *   - sigB64     = base64url(HMAC-SHA256(payloadB64, secret))
 *
 * Utilise INTERNAL_NOTIFY_SECRET comme clé HMAC (déjà partagée pour les
 * webhooks Supabase, on la réutilise pour rester sur une seule secret côté Railway).
 *
 * Le payload est public mais SIGNÉ — quiconque possède un token valide peut
 * confirmer la suppression du compte qu'il décrit. Mais pour générer un token
 * valide il faut connaître INTERNAL_NOTIFY_SECRET, ce qui n'est qu'en env Railway.
 *
 * Constraint: TTL court (1h par défaut) pour limiter la fenêtre d'attaque si
 * un email fuite (ex. boîte mail piratée temporairement).
 */

const crypto = require('crypto');

function getSecret() {
  const s = process.env.INTERNAL_NOTIFY_SECRET;
  if (!s || s.length < 16) {
    throw new Error('INTERNAL_NOTIFY_SECRET missing or too short');
  }
  return s;
}

function b64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/**
 * Génère un token signé pour la suppression d'un compte.
 * @param {Object} opts
 * @param {string} opts.user_id - UUID Supabase du user à supprimer
 * @param {string} opts.email   - Email du user (pour audit + envoi mail adieu)
 * @param {string} [opts.locale='fr'] - Locale du user pour l'email i18n
 * @param {number} [opts.ttlSeconds=3600] - Durée de validité (default 1h)
 * @returns {string} token au format `payload.sig`
 */
function signDeletionToken({ user_id, email, locale = 'fr', ttlSeconds = 3600 }) {
  if (!user_id || !email) throw new Error('signDeletionToken: user_id and email required');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    user_id,
    email,
    locale: locale === 'en' ? 'en' : 'fr',
    iat: now,
    exp: now + ttlSeconds,
    purpose: 'delete_account',
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/**
 * Vérifie un token signé. Retourne le payload décodé si valide, sinon null.
 * Vérifie : format, signature HMAC (constant-time), expiration, purpose.
 */
function verifyDeletionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  let expectedSig;
  try {
    expectedSig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  } catch {
    return null;
  }

  // Constant-time comparison
  if (expectedSig.length !== sigB64.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sigB64))) return null;
  } catch {
    return null;
  }

  // Decode + validate payload
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64));
  } catch {
    return null;
  }
  if (payload?.purpose !== 'delete_account') return null;
  if (!payload?.user_id || !payload?.email) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;

  return payload;
}

module.exports = { signDeletionToken, verifyDeletionToken };
