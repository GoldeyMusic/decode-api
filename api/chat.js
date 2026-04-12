const express = require('express');
const { chat } = require('../lib/claude');
const router = express.Router();
router.post('/', async (req, res) => {
  try {
    const { messages, item, daw, fadrData } = req.body;
    if (!messages) return res.status(400).json({ error:'messages required' });
    const system = `Tu es l'assistant Decode, expert production musicale. DAW: ${daw||'Logic Pro'}. Élément: ${item?.label||''}. ${item?.detail||''} ${fadrData?`BPM: ${fadrData.bpm}, Tonalité: ${fadrData.key}`:''} Réponds en français, paramètres précis, alternative gratuite pour chaque plugin.`;
    return res.json({ reply: await chat(messages, system) });
  } catch(err) { return res.status(500).json({ error: err.message }); }
});
module.exports = router;
