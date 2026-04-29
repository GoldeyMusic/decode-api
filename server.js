const express = require('express');
console.log('[startup] env check:', {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'present (' + process.env.OPENAI_API_KEY.length + ' chars)' : 'MISSING',
  SUPABASE_URL: process.env.SUPABASE_URL ? 'present' : 'MISSING',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? 'present' : 'MISSING',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'present' : 'MISSING',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'present' : 'MISSING',
});
const cors = require('cors');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin:'*', methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
// /api/billing/webhook a besoin du raw body (signature Stripe). Le router
// billing.js attache express.raw() directement à la route /webhook, donc
// on doit monter ce router AVANT express.json() global — sinon le body
// est déjà parsé en JSON et la signature ne match plus.
app.use('/api/billing', require('./api/_billing'));
app.use(express.json({ limit:'1mb' }));
app.get('/', (req, res) => res.json({ status:'ok', service:'Decode API' }));
app.use('/api/analyze', require('./api/_analyze'));
app.use('/api/chat', require('./api/_chat'));
app.use('/api/ask', require('./api/_ask'));
app.use('/api/listen', require('./api/_listen'));
app.use('/api/compare', require('./api/_compare'));
app.use('/api/translate', require('./api/_translate'));
app.use('/api/audio', require('./api/_audio-signed-url'));
// Upload direct navigateur → Supabase (bypass limite ~4,5 Mo Vercel body).
app.use('/api/storage', require('./api/_storage'));

// Sur Vercel, l'app n'est pas listen() — elle est invoquée comme une serverless
// function via api/index.js qui réexporte cet app. Le binaire fait `node server.js`
// uniquement en local (npm start). VERCEL=1 est défini par le runtime Vercel.
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Decode API running on port ${PORT}`));
}

module.exports = app;
