const express = require('express');
const { chat } = require('../lib/claude');
const router = express.Router();
router.post('/', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error:'messages required' });
    return res.json({ reply: await chat(messages, `Expert production musicale. Réponses claires, paramètres précis, alternative gratuite. Réponds en français.`) });
  } catch(err) { return res.status(500).json({ error: err.message }); }
});
module.exports = router;
