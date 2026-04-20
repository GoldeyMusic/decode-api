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
app.use(express.json({ limit:'1mb' }));
app.get('/', (req, res) => res.json({ status:'ok', service:'Decode API' }));
app.use('/api/analyze', require('./api/analyze'));
app.use('/api/chat', require('./api/chat'));
app.use('/api/ask', require('./api/ask'));
app.use('/api/listen', require('./api/listen'));
app.use('/api/compare', require('./api/compare'));
app.use('/api/translate', require('./api/translate'));
app.use('/api/audio', require('./api/audio-signed-url'));
app.listen(PORT, () => console.log(`Decode API running on port ${PORT}`));
