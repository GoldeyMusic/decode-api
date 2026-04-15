const express = require('express');
const { chat } = require('../lib/claude');
const router = express.Router();

const SYSTEM_PROMPT = `Tu es expert en mixage et mastering. On te donne deux fiches d'analyse de deux versions d'un même titre (A = version antérieure, B = version plus récente).

Ton travail : comparer B par rapport à A et produire un delta structuré.

Réponds UNIQUEMENT avec un JSON valide, sans markdown, sans texte avant/après. Format strict :

{
  "resume": "une phrase courte qui caractérise l'évolution globale",
  "progres": [
    { "titre": "court (5-8 mots)", "detail": "1 phrase précise" }
  ],
  "regressions": [
    { "titre": "court (5-8 mots)", "detail": "1 phrase précise" }
  ],
  "inchanges": [
    { "titre": "court (5-8 mots)", "detail": "1 phrase précise" }
  ]
}

Règles :
- Sois factuel, pas complaisant. Si B a régressé sur un point, dis-le.
- Nuance : un "progrès" doit être concret (ex: "voix mieux intégrée dans le haut médium"), pas générique.
- Max 5 items par catégorie. Privilégie la qualité à la quantité.
- Si une catégorie est vide, renvoie un tableau [].
- Pas de mention de "Gemini", "Claude", "IA", "LLM", ni du process interne.`;

router.post('/', async (req, res) => {
  try {
    const { ficheA, ficheB, nameA, nameB } = req.body;
    if (!ficheA || !ficheB) return res.status(400).json({ error: 'ficheA et ficheB requis' });

    const userMsg = `VERSION A (${nameA || 'A'}) :\n${JSON.stringify(ficheA, null, 2)}\n\nVERSION B (${nameB || 'B'}) :\n${JSON.stringify(ficheB, null, 2)}\n\nCompare B par rapport à A. Réponds en JSON strict.`;

    const raw = await chat([{ role: 'user', content: userMsg }], SYSTEM_PROMPT);

    let parsed;
    try {
      const cleaned = raw.replace(/```json\s*|\s*```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({ error: 'format invalide', raw });
    }

    return res.json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
