const express = require('express');
const { chat } = require('../lib/claude');
const router = express.Router();

const SYSTEM_PROMPT = `Tu compares deux fiches d'analyse d'un même titre musical (A = version antérieure, B = version plus récente).

RÈGLE NUMÉRO UN : ne pas inventer de différences.
Deux fiches du même titre peuvent contenir des formulations différentes pour des réalités identiques. Ce ne sont PAS des vrais changements. Ne relève comme "progrès" ou "régression" QUE ce qui est factuellement observable dans les données :
- Une note chiffrée qui change d'au moins 2 points.
- Un élément musical présent dans une fiche et absent de l'autre (ex : chœurs, synthé, voix lead, etc.).
- Un item du plan d'action qui disparaît ou apparaît.
- Un tag technique explicite (présence d'une compression, d'un effet, d'un conflit spectral nommé) qui est présent dans une fiche et pas l'autre.

Tout le reste — reformulations, nuances d'interprétation, réévaluations de 1 point, phrases qui disent "à peu près la même chose autrement" — va dans "inchanges" avec un titre neutre, OU est simplement ignoré.

Si les deux versions sont très proches, il est parfaitement normal et attendu que progres et regressions soient presque vides. Ne remplis pas pour remplir.

FOCUS sur ce qui change le plus dans la musique :
- Instruments ajoutés/retirés (chœurs, pads, guitares, etc.) — CRUCIAL
- Arrangement (densité, sections, breaks)
- Mix (balance, spatialisation, dynamique globale)
- Master (LUFS, score global)

Réponds UNIQUEMENT avec un JSON valide, sans markdown, sans texte avant/après :

{
  "resume": "une phrase courte, factuelle, qui caractérise l'évolution réelle — ou 'Les deux versions sont très proches' si c'est le cas",
  "progres": [ { "titre": "court", "detail": "1 phrase factuelle qui cite la donnée source" } ],
  "regressions": [ { "titre": "court", "detail": "1 phrase factuelle" } ],
  "inchanges": [ { "titre": "court", "detail": "1 phrase" } ]
}

Règles :
- Max 5 items par catégorie. Souvent beaucoup moins.
- Si une catégorie est vide, renvoie [].
- Pas de mention de "Gemini", "Claude", "IA", "LLM", ni du process interne.
- Français.`;

router.post('/', async (req, res) => {
  try {
    const { ficheA, ficheB, nameA, nameB } = req.body;
    if (!ficheA || !ficheB) return res.status(400).json({ error: 'ficheA et ficheB requis' });

    const userMsg = `VERSION A (${nameA || 'A'}) :\n${JSON.stringify(ficheA, null, 2)}\n\nVERSION B (${nameB || 'B'}) :\n${JSON.stringify(ficheB, null, 2)}\n\nCompare B par rapport à A en suivant les règles strictes. Réponds en JSON strict.`;

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
