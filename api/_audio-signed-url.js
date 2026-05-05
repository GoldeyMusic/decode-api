// api/audio-signed-url.js
// Génère une URL signée temporaire pour lire un fichier audio depuis Supabase Storage.
// GET /api/audio/signed-url?path=userId/1234-abcd.mp3
//
// Auth : Bearer JWT obligatoire (requireAuth dans server.js).
// Sécurité : on vérifie que `path` appartient bien au user authentifié,
// sinon n'importe qui pourrait télécharger l'audio d'un autre user.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { userOwnsPath } = require('../lib/auth');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Whitelist : extension autorisée + structure de path.
// Format attendu : <userId>/<filename>.<ext>  (optionnellement préfixé tmp/)
// Bloque le path traversal (../, encodage, slashes multiples).
const SAFE_PATH = /^(tmp\/)?[a-f0-9-]{36}\/[\w.-]+\.(wav|mp3|aac|m4a|flac|ogg|opus|aiff|aif)$/i;

router.get('/signed-url', async (req, res) => {
  const { path } = req.query;
  if (!path || typeof path !== 'string') {
    return res.status(400).json({ error: 'path required' });
  }
  if (!SAFE_PATH.test(path)) {
    return res.status(400).json({ error: 'path_invalid' });
  }
  if (!userOwnsPath(req.user, path)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    // TTL 24h : l'URL reste stable le temps d'une journée de travail, donc
    // le navigateur conserve son cache HTTP (mêmes params de requête) au lieu
    // de re-télécharger le fichier à chaque renouvellement d'URL signée.
    const { data, error } = await supabase.storage
      .from('audio')
      .createSignedUrl(path, 86400); // 24h

    if (error) {
      console.error('[audio] signed-url error:', error.message);
      return res.status(500).json({ error: 'signed_url_failed' });
    }

    res.json({ url: data.signedUrl });
  } catch (err) {
    console.error('[audio] signed-url threw:', err.message);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
