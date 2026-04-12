const express = require('express');
const multer = require('multer');
const { analyzeFile, extractFadrData } = require('../lib/fadr');
const { generateFiche } = require('../lib/claude');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200*1024*1024 } });

router.post('/', upload.single('file'), async (req, res) => {
  try {
    let fadrData = null;
    const mode = req.body.mode, daw = req.body.daw;
    const title = req.body.title || (req.file ? req.file.originalname.replace(/\.[^/.]+$/,'') : '');
    const artist = req.body.artist || '';
    if (!mode || !daw) return res.status(400).json({ error:'mode and daw required' });

    if (req.file) {
      const ext = req.file.originalname.split('.').pop().toLowerCase();
      console.log(`[analyze] ${req.file.originalname} (${Math.round(req.file.size/1024)}KB)`);
      const task = await analyzeFile(req.file.buffer, req.file.originalname, ext, req.file.mimetype||'audio/mpeg', (s,p)=>console.log(`[fadr] ${s}: ${p}%`));
      fadrData = extractFadrData(task);
    }

    console.log('[claude] generating fiche — mode:', mode, 'daw:', daw, 'title:', title);
    const fiche = await generateFiche(fadrData, mode, daw, title||'Titre inconnu', artist);
    console.log('[claude] fiche generated OK — keys:', Object.keys(fiche).join(', '));

    return res.json({ success:true, fiche, fadrData, meta:{ title, artist, daw, mode } });
  } catch(err) {
    console.error('[analyze] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
