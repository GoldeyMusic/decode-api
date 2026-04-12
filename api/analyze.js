const express = require('express');
const multer = require('multer');
const { analyzeFile, extractFadrData } = require('../lib/fadr');
const { generateFiche } = require('../lib/claude');
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
  jobs.set(jobId, { status: 'pending', progress: 'Démarrage…' });
  res.json({ jobId });

  // Run analysis in background
  (async () => {
    try {
      const mode = req.body.mode, daw = req.body.daw;
      const title = req.body.title || (req.file ? req.file.originalname.replace(/\.[^/.]+$/, '') : '');
      const artist = req.body.artist || '';
      let fadrData = null;

      if (req.file) {
        const ext = req.file.originalname.split('.').pop().toLowerCase();
        console.log(`[analyze] ${req.file.originalname} (${Math.round(req.file.size/1024)}KB)`);
        const task = await analyzeFile(req.file.buffer, req.file.originalname, ext, req.file.mimetype||'audio/mpeg', (step, pct) => {
          jobs.set(jobId, { status: 'pending', progress: step, pct });
        });
        fadrData = extractFadrData(task);
      }

      jobs.set(jobId, { status: 'pending', progress: 'Génération IA…', pct: 90 });
      const fiche = await generateFiche(fadrData, mode, daw, title||'Titre inconnu', artist);
      console.log('[analyze] done — keys:', Object.keys(fiche).join(', '));
      jobs.set(jobId, { status: 'complete', fiche, fadrData, meta: { title, artist, daw, mode } });
    } catch(err) {
      console.error('[analyze] error:', err.message);
      jobs.set(jobId, { status: 'error', error: err.message });
    }
  })();
});

// GET /api/analyze/status/:jobId — poll for result
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
