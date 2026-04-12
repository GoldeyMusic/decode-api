const express = require('express');
const multer = require('multer');
const { analyzeListening } = require('../lib/gemini');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200*1024*1024 } });
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error:'file required' });
    const { title, artist, mode, daw } = req.body;
    const fadrData = req.body.fadrData ? JSON.parse(req.body.fadrData) : null;
    const result = await analyzeListening(req.file.buffer.toString('base64'), req.file.mimetype||'audio/mpeg', title||'', artist||'', fadrData, mode, daw);
    return res.json({ success:true, listening: result });
  } catch(err) { return res.status(500).json({ error: err.message }); }
});
module.exports = router;
