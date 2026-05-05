const express = require('express');
console.log('[startup] env check:', {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'present' : 'MISSING',
  SUPABASE_URL: process.env.SUPABASE_URL ? 'present' : 'MISSING',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? 'present' : 'MISSING',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'present' : 'MISSING',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'present' : 'MISSING',
});
const cors = require('cors');
const { requireAuth } = require('./lib/auth');
const {
  chatLimiter, askLimiter, translateLimiter, compareLimiter,
  masteringCharterLimiter, analyzeLimiter, listenLimiter,
  storageLimiter, audioLimiter,
} = require('./lib/rateLimit');
const app = express();
// Railway/Vercel : trust proxy pour que express-rate-limit voie la vraie IP
// dans X-Forwarded-For (sinon tous les requests partagent la même IP edge
// et un seul user peut DoS le rate limit pour tout le monde).
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ─── CORS — whitelist explicite ───────────────────────────────────
// Liste des origines autorisées en prod. Tout le reste est rejeté.
// Permet aussi l'absence d'Origin (curl, scripts serveur-à-serveur,
// requêtes same-origin sur la même Vercel preview).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'https://versions.studio,https://www.versions.studio,http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, server-to-server
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

// /api/billing/webhook a besoin du raw body (signature Stripe). Le router
// billing.js attache express.raw() directement à la route /webhook, donc
// on doit monter ce router AVANT express.json() global — sinon le body
// est déjà parsé en JSON et la signature ne match plus.
//
// NB : le router billing gère lui-même son auth (Bearer JWT pour /checkout,
// signature Stripe pour /webhook, public pour /health). On ne préfixe donc
// PAS requireAuth ici globalement.
app.use('/api/billing', require('./api/_billing'));
app.use(express.json({ limit: '1mb' }));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Versions API' }));

// ─── Endpoints authentifiés ───────────────────────────────────────
// Tous ces routers exigent un Bearer JWT Supabase. requireAuth pose
// req.user.id et req.user.email. Les endpoints DOIVENT utiliser
// req.user.id (jamais req.body.userId) pour identifier l'auteur.
// Rate-limit appliqué après l'auth pour cibler par user.id.
app.use('/api/analyze', requireAuth, analyzeLimiter, require('./api/_analyze'));
app.use('/api/chat', requireAuth, chatLimiter, require('./api/_chat'));
app.use('/api/mastering-charter', requireAuth, masteringCharterLimiter, require('./api/_mastering_charter'));
app.use('/api/ask', requireAuth, askLimiter, require('./api/_ask'));
app.use('/api/listen', requireAuth, listenLimiter, require('./api/_listen'));
app.use('/api/compare', requireAuth, compareLimiter, require('./api/_compare'));
app.use('/api/translate', requireAuth, translateLimiter, require('./api/_translate'));
app.use('/api/audio', requireAuth, audioLimiter, require('./api/_audio-signed-url'));
// Upload direct navigateur → Supabase (bypass limite ~4,5 Mo Vercel body).
app.use('/api/storage', requireAuth, storageLimiter, require('./api/_storage'));

// Sur Vercel, l'app n'est pas listen() — elle est invoquée comme une serverless
// function via api/index.js qui réexporte cet app. Le binaire fait `node server.js`
// uniquement en local (npm start). VERCEL=1 est défini par le runtime Vercel.
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Versions API running on port ${PORT}`));
}

module.exports = app;
