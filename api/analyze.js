const express = require('express');
const multer = require('multer');
const { analyzeFile, extractFadrData } = require('../lib/fadr');
const { generateFiche } = require('../lib/claude');
const { analyzeListening } = require('../lib/gemini');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200*1024*1024 } });

// In-memory job store
const jobs = new Map();

function makeJobId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// POST /api/analyze/start — starts job, returns jobId immediately
router.post('/start', upload.single('file'), async (req, res) => {
  const jobId = makeJobId();
  jobs.set(jobId, { status: 'pending', progress: 'Démarrage…', pct: 0 });
  res.json({ jobId });

  // Run analysis in background — progressive stages
  (async () => {
    try {
      const mode = req.body.mode, daw = req.body.daw;
      const title = req.body.title || (req.file ? req.file.originalname.replace(/\.[^/.]+$/, '') : '');
      const version = req.body.version || '';
      const artist = req.body.artist || '';
      let fadrData = null;
      let fileBuffer = null;
      let fileMime = null;

      // ── STAGE 1: Fadr analysis ──────────────────────────
      if (req.file) {
        fileBuffer = req.file.buffer;
        fileMime = req.file.mimetype || 'audio/mpeg';
        const ext = req.file.originalname.split('.').pop().toLowerCase();
        console.log(`[analyze] ${req.file.originalname} (${Math.round(req.file.size/1024)}KB)`);

        const task = await analyzeFile(fileBuffer, req.file.originalname, ext, fileMime, (step, pct) => {
          jobs.set(jobId, { ...jobs.get(jobId), progress: step, pct: Math.round(pct * 0.6) }); // Fadr = 0-60%
        });
        fadrData = extractFadrData(task);
      }

      // ── Deliver fadrData immediately (partial result) ───
      const meta = { title, artist, daw, mode, version };
      jobs.set(jobId, {
        status: 'partial',
        stage: 'fadr_done',
        progress: 'Données audio prêtes',
        pct: 60,
        fadrData,
        meta,
      });

      // ── STAGE 2 & 3: Claude + Gemini in parallel ───────
      const claudePromise = (async () => {
        try {
          const fiche = await generateFiche(fadrData, mode, daw, title || 'Titre inconnu', artist);
          console.log('[analyze] claude done — keys:', Object.keys(fiche).join(', '));
          return fiche;
        } catch (err) {
          console.error('[analyze] claude error:', err.message);
          return null;
        }
      })();

      const geminiPromise = (async () => {
        if (!fileBuffer) return null;
        try {
          const listening = await analyzeListening(
            fileBuffer.toString('base64'),
            fileMime,
            title || '',
            artist || '',
            fadrData,
            mode,
            daw
          );
          console.log('[analyze] listening done');
          return listening;
        } catch (err) {
          console.error('[analyze] listening error:', err.message);
          return null;
        }
      })();

      // Wait for Claude first (usually faster)
      const fiche = await claudePromise;
      console.log('[analyze] fiche result:', fiche ? Object.keys(fiche).join(', ') : 'NULL');
      if (fiche) {
        const cur1 = jobs.get(jobId) || {};
        jobs.set(jobId, {
          ...cur1,
          status: 'partial',
          stage: 'fiche_done',
          progress: 'Rapport IA prêt',
          pct: 85,
          fiche,
        });
      }

      // Wait for listening analysis
      const listening = await geminiPromise;
      console.log('[analyze] listening result:', listening ? 'OK' : 'NULL');
      const cur2 = jobs.get(jobId) || {};
      jobs.set(jobId, {
        ...cur2,
        status: 'complete',
        stage: 'all_done',
        progress: 'Terminé',
        pct: 100,
        fiche: cur2.fiche || fiche,
        listening: listening || null,
      });

      console.log('[analyze] done — keys:', Object.keys(cur2.fiche || fiche || {}).join(', '));
    } catch (err) {
      console.error('[analyze] error:', err.message);
      jobs.set(jobId, { status: 'error', error: err.message });
    }
  })();
});

// GET /api/analyze/status/:jobId — poll for result (returns partial data too)
router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
  // Clean up completed/errored jobs after delivery
  if (job.status === 'complete' || job.status === 'error') {
    setTimeout(() => jobs.delete(req.params.jobId), 60000);
  }
});

module.exports = router;
