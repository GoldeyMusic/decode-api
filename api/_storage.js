// api/_storage.js
// Endpoint sign-upload : retourne une URL signée temporaire pour PUT direct
// d'un fichier audio depuis le navigateur vers Supabase Storage. Permet de
// bypasser la limite ~4,5 Mo body de Vercel serverless sur /api/analyze/start.
//
// Flow côté client (cf. UPLOAD_DIRECT_PLAN.md) :
//   1. POST /api/storage/sign-upload  { userId, ext } → { storagePath, uploadUrl, token }
//   2. fetch(uploadUrl, { method: 'PUT', body: file }) directement vers Supabase
//   3. POST /api/analyze/start  { storagePath, ...metadata }  (body JSON minuscule)
//
// Le path retourné est `tmp/{userId}/{timestamp}-{uuid}.{ext}`. Le préfixe
// `tmp/` permet à la RLS Supabase de borner les écritures par utilisateur :
//   bucket_id='audio' AND (storage.foldername(name))[1]='tmp'
//   AND (storage.foldername(name))[2]=auth.uid()::text
// Le backend utilise ensuite la SERVICE_ROLE_KEY pour télécharger le fichier
// dans /api/analyze/start (RLS bypass autorisé) puis nettoyer le tmp/ après
// transcodage final.

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Whitelist conservatrice — extensions audio qu'on accepte côté upload
// direct. Cohérent avec ce que Fadr/Gemini savent traiter.
const ALLOWED_EXTS = new Set(['wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aiff', 'aif']);

router.post('/sign-upload', async (req, res) => {
  const { userId, ext } = req.body || {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'userId requis' });
  }
  // Sanitize : uniquement [a-z0-9], 1-5 chars, fallback 'wav'.
  let safeExt = String(ext || 'wav').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  if (!ALLOWED_EXTS.has(safeExt)) safeExt = 'wav';

  const storagePath = `tmp/${userId}/${Date.now()}-${randomUUID()}.${safeExt}`;

  try {
    const { data, error } = await supabase.storage
      .from('audio')
      .createSignedUploadUrl(storagePath);

    if (error) {
      console.error('[storage] sign-upload error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({
      storagePath,
      uploadUrl: data.signedUrl,
      token: data.token,
    });
  } catch (err) {
    console.error('[storage] sign-upload threw:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
