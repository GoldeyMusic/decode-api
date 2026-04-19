const express = require('express');
const multer = require('multer');
const { generateFiche } = require('../lib/claude');
const { analyzeListening } = require('../lib/gemini');
const { retrievePureMixContext, formatContextForPrompt } = require('../lib/rag');
const { transcodeAndUpload } = require('../lib/audio-storage');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const jobs = new Map();
function makeJobId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// Flow: Gemini (ecoute) -> RAG PureMix (extraits pertinents) -> Claude (fiche enrichie).
// En parallèle de RAG+Claude: transcodage MP3 + upload Supabase Storage.
router.post('/start', upload.single('file'), async (req, res) => {
  const jobId = makeJobId();
  jobs.set(jobId, { status: 'pending', progress: 'Démarrage…', pct: 0 });
  res.json({ jobId });

  (async () => {
    try {
      const mode = req.body.mode, daw = req.body.daw;
      const title = req.body.title || (req.file ? req.file.originalname.replace(/\.[^/.]+$/, '') : '');
      const version = req.body.version || '';
      const artist = req.body.artist || '';
      const userId = req.body.userId || null;
      // Type vocal du titre (migration 004) : 'vocal' (défaut), 'instrumental_pending', 'instrumental_final'
      // Utilisé pour adapter Gemini + Claude : pas de mention de voix sur un instru définitif,
      // voix traitée comme étape à venir (non pénalisante) sur un instru temporaire.
      const allowedVocalTypes = ['vocal', 'instrumental_pending', 'instrumental_final'];
      const vocalType = allowedVocalTypes.includes(req.body.vocalType) ? req.body.vocalType : 'vocal';
      let fileBuffer = null, fileMime = null;

      if (req.file) {
        fileBuffer = req.file.buffer;
        fileMime = req.file.mimetype || 'audio/mpeg';
        console.log(`[analyze] ${req.file.originalname} (${Math.round(req.file.size / 1024)}KB)`);
      }

      const meta = { title, artist, daw, mode, version };
      jobs.set(jobId, {
        status: 'pending', stage: 'started',
        progress: 'Préparation de l\'écoute…', pct: 10,
        meta,
      });

      // ── STAGE 1: Gemini listening ──────────────
      let listening = null;
      if (fileBuffer) {
        try {
          listening = await analyzeListening(fileBuffer, fileMime, title || '', artist || '', mode, vocalType);
          console.log('[analyze] listening done');
        } catch (err) {
          console.error('[analyze] listening error:', err.message);
          listening = null;
        }
      }
      const cur1 = jobs.get(jobId) || {};
      jobs.set(jobId, {
        ...cur1,
        status: 'partial', stage: 'listening_done',
        progress: listening ? 'Écoute qualitative prête' : 'Écoute indisponible',
        pct: 60,
        listening: listening || null,
      });

      // ── STAGE PARALLÈLE: transcodage MP3 + upload Supabase ──
      // Lancé en parallèle de RAG+Claude pour ne pas ajouter à la latence perçue.
      let storagePromise = null;
      if (fileBuffer && userId) {
        storagePromise = transcodeAndUpload({ fileBuffer, fileMime, userId })
          .then((path) => { console.log('[analyze] audio stored:', path); return path; })
          .catch((err) => { console.error('[analyze] storage error:', err.message); return null; });
      } else if (!userId) {
        console.warn('[analyze] no userId, skipping audio upload');
      }

      // ── STAGE 2: RAG PureMix context ───────────
      let pmChunks = [];
      if (listening) {
        try {
          pmChunks = await retrievePureMixContext(listening);
          console.log(`[analyze] rag: ${pmChunks.length} chunks retrieved`);
        } catch (err) {
          console.error('[analyze] rag error:', err.message);
          pmChunks = [];
        }
      }
      const pmContext = formatContextForPrompt(pmChunks);
      const cur15 = jobs.get(jobId) || {};
      jobs.set(jobId, {
        ...cur15,
        stage: 'rag_done',
        progress: 'Contexte PureMix prêt',
        pct: 75,
      });

      // ── STAGE 3: Claude fiche (uses listening + pmContext) ─
      let fiche = null;
      try {
        const durationSeconds = parseFloat(req.body.durationSeconds) || null; let previousFiche = null; try { previousFiche = req.body.previousFiche ? JSON.parse(req.body.previousFiche) : null; } catch {} fiche = await generateFiche(mode, daw, title || "Titre inconnu", artist, listening, pmContext, previousFiche, vocalType); if (fiche && durationSeconds) fiche.duration_seconds = durationSeconds;
        console.log('[analyze] claude done — keys:', Object.keys(fiche || {}).join(', '));
      } catch (err) {
        console.error('[analyze] claude error:', err.message);
      }

      // Attend la fin du transcodage/upload (peut avoir fini depuis longtemps)
      const storagePath = storagePromise ? await storagePromise : null;

      const cur2 = jobs.get(jobId) || {};
      jobs.set(jobId, {
        ...cur2,
        status: 'complete', stage: 'all_done',
        progress: 'Terminé', pct: 100,
        fiche: fiche || null,
        listening: listening || null,
        storagePath: storagePath || null,
        // On renvoie les sources citees (sans le contenu complet) pour eventuel affichage
        pmSources: pmChunks.map(c => ({
          source_file: c.source_file,
          category: c.category,
          similarity: c.similarity,
        })),
      });
      console.log('[analyze] done');
    } catch (err) {
      console.error('[analyze] error:', err.message);
      jobs.set(jobId, { status: 'error', error: err.message });
    }
  })();
});

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
  if (job.status === 'complete' || job.status === 'error') {
    setTimeout(() => jobs.delete(req.params.jobId), 60000);
  }
});


module.exports = router;
