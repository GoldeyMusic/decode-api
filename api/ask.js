const express = require('express');
const { chat } = require('../lib/claude');
const router = express.Router();
router.post('/', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error:'messages required' });
    const locale = (req.body.locale || 'fr').toString().toLowerCase().slice(0, 2);
    const system = locale === 'en'
      ? `Music production expert. Clear answers, precise parameters, a free alternative for every paid plugin mentioned. Respond in English.`
      : `Expert production musicale. Réponses claires, paramètres précis, alternative gratuite. Réponds en français.`;
    return res.json({ reply: await chat(messages, system) });
  } catch(err) { return res.status(500).json({ error: err.message }); }
});
module.exports = router;
