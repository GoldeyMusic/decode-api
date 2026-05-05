/**
 * lib/rateLimit.js — limiteurs de requêtes par user.
 *
 * Tous les limiteurs s'appliquent APRÈS requireAuth (donc req.user.id
 * est disponible). Sur les requêtes anonymes (théoriquement bloquées
 * par requireAuth en amont), on retombe sur req.ip pour ne pas planter.
 *
 * Note serverless : sur Railway en single-process la mémoire est
 * partagée entre toutes les routes. Sur Vercel (decode-kappa legacy),
 * chaque invocation est isolée → le rate-limit ne survit pas. C'est
 * acceptable comme filet anti-bot ; pour un blocage strict il faudra
 * un store Redis (à voir si la facture LLM dépasse).
 */

const rateLimit = require('express-rate-limit');

// Identifiant : l'user.id du JWT (préféré) ou l'IP en fallback.
const keyByUser = (req) => req.user?.id || req.ip;

// /chat — 30 req / min / user. Le chat est le plus chaud (RAG + Sonnet).
const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: 'rate_limited' },
});

// /ask — même profil que /chat.
const askLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: 'rate_limited' },
});

// /translate — 60 req / min (utilisé pour la bascule FR↔EN d'une fiche
// déjà générée, peut être appelé en rafale au switch de langue).
const translateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: 'rate_limited' },
});

// /compare — 20 req / min (rare, comparaison de 2 fiches).
const compareLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: 'rate_limited' },
});

// /mastering-charter — 10 req / min (seed message, appelé 1× par chat).
const masteringCharterLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: 'rate_limited' },
});

// /analyze/start — 10 req / heure / user. C'est le plus coûteux (Gemini
// + Claude Sonnet + Fadr + DSP). Combiné au cap crédits, ça borne le pire
// cas même si la balance est très haute.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: 'rate_limited' },
});

// /listen — 20 req / heure (analyse Gemini brute, parfois utilisé
// avant /analyze/start pour le sample report).
const listenLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: 'rate_limited' },
});

// /storage/sign-upload — 60 req / min (1 par upload audio).
const storageLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: 'rate_limited' },
});

// /audio/signed-url — 120 req / min (peut spammer au load d'un dashboard
// avec beaucoup de versions). Borne raisonnable.
const audioLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  message: { error: 'rate_limited' },
});

module.exports = {
  chatLimiter,
  askLimiter,
  translateLimiter,
  compareLimiter,
  masteringCharterLimiter,
  analyzeLimiter,
  listenLimiter,
  storageLimiter,
  audioLimiter,
};
