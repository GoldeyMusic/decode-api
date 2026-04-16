// api/audio-signed-url.js
// Génère une URL signée temporaire pour lire un fichier audio depuis Supabase Storage.
// GET /api/audio/signed-url?path=userId/1234-abcd.mp3

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

router.get('/signed-url', async (req, res) => {
  const { path } = req.query;
  if (!path) {
    return res.status(400).json({ error: 'path requis' });
  }

  try {
    const { data, error } = await supabase.storage
      .from('audio')
      .createSignedUrl(path, 3600); // 1h

    if (error) {
      console.error('[audio] signed-url error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({ url: data.signedUrl });
  } catch (err) {
    console.error('[audio] signed-url error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
