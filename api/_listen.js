const express = require('express');
const multer = require('multer');
const { analyzeListening } = require('../lib/gemini');
const router = express.Router();

// Cap upload : 80 Mo (cohérent avec le cap durée 12 min audio mentionné
// dans /analyze). multer en memoryStorage → des fichiers de 200 Mo en
// parallèle saturent la RAM Railway. 80 Mo couvre 12 min de WAV 16-bit
// 44.1 kHz mono ou 12 min de MP3/AAC stéréo qualité haute.
const UPLOAD_LIMIT = 80 * 1024 * 1024;
const MAX_AUDIO_DURATION_SEC = 12 * 60; // 12 min — aligné avec /analyze.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_LIMIT } });

router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });

    // Garde-fou durée audio (cap 12 min) — aligné avec /analyze/start.
    // Le front envoie durationSeconds via HTMLAudioElement. On revalide
    // ici pour bloquer un éventuel bypass (curl, script tiers).
    const durationSecondsRaw = parseFloat(req.body.durationSeconds);
    if (Number.isFinite(durationSecondsRaw) && durationSecondsRaw > MAX_AUDIO_DURATION_SEC) {
      return res.status(413).json({
        error: 'audio_too_long',
        maxSeconds: MAX_AUDIO_DURATION_SEC,
        receivedSeconds: Math.round(durationSecondsRaw),
      });
    }

    const { title, artist, mode, daw } = req.body;
    const fadrData = req.body.fadrData ? JSON.parse(req.body.fadrData) : null;
    const result = await analyzeListening(
      req.file.buffer.toString('base64'),
      req.file.mimetype || 'audio/mpeg',
      title || '', artist || '', fadrData, mode, daw
    );
    return res.json({ success: true, listening: result });
  } catch (err) {
    console.error('[listen] error:', err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
