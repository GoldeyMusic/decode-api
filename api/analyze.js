const express = require('express');
const multer = require('multer');
const { analyzeFile, extractFadrData } = require('../lib/fadr');
const { generateFiche } = require('../lib/claude');
const { analyzeListening } = require('../lib/gemini');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const jobs = new Map();
function makeJobId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// Flow: Fadr -> Gemini (listening) -> Claude (uses listening). Sequential so
// Claude's fiche can lean on Gemini's actual observations instead of inventing.
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
      let fadrData = null, fileBuffer = null, fileMime = null;

      // ── STAGE 1: Fadr ──────────────────────────
      if (req.file) {
        fileBuffer = req.file.buffer;
        fileMime = req.file.mimetype || 'audio/mpeg';
        const ext = req.file.originalname.split('.').pop().toLowerCase();
        console.log(`[analyze] ${req.file.originalname} (${Math.round(req.file.size / 1024)}KB)`);
        const task = await analyzeFile(fileBuffer, req.file.originalname, ext, fileMime, (step, pct) => {
          jobs.set(jobId, { ...jobs.get(jobId), progress: step, pct: Math.round(pct * 0.5) });
        });
        fadrData = extractFadrData(task);
      }

      const meta = { title, artist, daw, mode, version };
      jobs.set(jobId, {
        status: 'partial', stage: 'fadr_done',
        progress: 'Données audio prêtes', pct: 50,
        fadrData, meta,
      });

      // ── STAGE 2: Gemini listening ──────────────
      let listening = null;
      if (fileBuffer) {
        try {
          listening = await analyzeListening(fileBuffer, fileMime, title || '', artist || '', fadrData, mode);
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
        pct: 80,
        listening: listening || null,
      });

      // ── STAGE 3: Claude fiche (uses listening) ─
      let fiche = null;
      try {
        fiche = await generateFiche(fadrData, mode, daw, title || 'Titre inconnu', artist, listening);
        console.log('[analyze] claude done — keys:', Object.keys(fiche || {}).join(', '));
      } catch (err) {
        console.error('[analyze] claude error:', err.message);
      }

      const cur2 = jobs.get(jobId) || {};
      jobs.set(jobId, {
        ...cur2,
        status: 'complete', stage: 'all_done',
        progress: 'Terminé', pct: 100,
        fiche: fiche || null,
        listening: listening || null,
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
