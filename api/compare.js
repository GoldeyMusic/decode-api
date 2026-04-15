const express = require('express');
const { chat } = require('../lib/claude');
const router = express.Router();

const SYSTEM_PROMPT = `Tu compares deux fiches d'analyse d'un même titre musical (A = version antérieure, B = version plus récente).

RÈGLE NUMÉRO UN : ne pas inventer de différences.
Deux fiches du même titre peuvent contenir des formulations différentes pour des réalités identiques. Ce ne sont PAS des vrais changements. Ne relève comme "progrès" ou "régression" QUE ce qui est factuellement observable dans les données.

MÉTHODE OBLIGATOIRE — fais ces étapes dans cet ordre :

1) DIFF DES ÉLÉMENTS MUSICAUX (priorité absolue)
   Chaque fiche a un champ "elements_detectes" qui liste TOUT ce qui est entendu (par famille : voix, drums, basses, instruments, spatial).
   Compare ces deux listes famille par famille :
   - Élément présent dans B mais absent de A → "progrès" si c'est un ajout musical (chœurs, pad, guitare, etc.) avec titre du type "Chœurs ajoutés", "Pad ajouté".
   - Élément présent dans A mais absent de B → "régression" SAUF si c'est manifestement volontaire et propre (rare) — dans le doute, signaler avec titre "X retiré".
   - Élément présent dans les deux → ne rien dire.
   Cette étape est la PLUS IMPORTANTE pour la crédibilité du delta.

2) DIFF DES SCORES
   - globalScore : variation ≥ 2 points = progrès/régression.
   - elements[].items[].score : pour les items qui existent dans les deux fiches (même id ou même label proche), variation ≥ 2 points = à signaler.

3) DIFF DU PLAN D'ACTION
   - Item présent dans A et absent de B → "progrès" (ex: "Voix lead résolue").
   - Item présent dans B et absent de A → potentielle "régression" (nouveau problème détecté).

Tout le reste — reformulations, nuances d'interprétation, réévaluations de 1 point, phrases qui disent "à peu près la même chose autrement" — va dans "inchanges" avec un titre neutre, OU est simplement ignoré.

Si les deux versions sont très proches, il est parfaitement normal et attendu que progres et regressions soient presque vides. Ne remplis pas pour remplir.

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
- Pas de mention de "Gemini", "Claude", "IA", "LLM", "elements_detectes" (jamais ce mot dans le texte affiche, parle d "elements detectes" ou "elements entendus"), ni du process interne.
- Français.`;

router.post('/', async (req, res) => {
  try {
    const { ficheA, ficheB, nameA, nameB } = req.body;
    if (!ficheA || !ficheB) return res.status(400).json({ error: 'ficheA et ficheB requis' });

    const userMsg = `VERSION A (${nameA || 'A'}) :\n${JSON.stringify(ficheA, null, 2)}\n\nVERSION B (${nameB || 'B'}) :\n${JSON.stringify(ficheB, null, 2)}\n\nApplique la méthode obligatoire : commence par diffuser elements_detectes famille par famille, puis les scores, puis le plan. Réponds en JSON strict.`;

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
