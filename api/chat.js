const express = require('express');
const { chat } = require('../lib/claude');
const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { messages, item, daw, fadrData, listening, fiche, title, artist, version } = req.body;
    if (!messages) return res.status(400).json({ error: 'messages required' });

    let system;

    // Chat "version-wide" : l'utilisateur pose des questions sur la version affichée.
    // On envoie à Claude l'écoute qualitative + la fiche d'analyse comme contexte.
    if (listening || fiche) {
      const parts = [
        `Tu es l'assistant Versions, ingénieur du son expert (20+ ans d'expérience), intégré dans une app d'analyse de production musicale.`,
        `DAW de l'utilisateur : ${daw || 'Logic Pro'}.`,
      ];
      if (title) parts.push(`Morceau actuellement analysé : "${title}"${artist ? ' — ' + artist : ''}.`);
      if (version) parts.push(`Version affichée : ${version}.`);
      if (listening) parts.push(`\n\n--- ÉCOUTE QUALITATIVE DE CE MORCEAU ---\n${JSON.stringify(listening, null, 2)}`);
      if (fiche) parts.push(`\n\n--- FICHE D'ANALYSE ACTUELLE (diagnostic + plan d'action) ---\n${JSON.stringify(fiche, null, 2)}`);
      parts.push(
        `\n\nL'utilisateur te pose des questions sur ce morceau, cette analyse, ou la production en général. ` +
        `Ancre tes réponses dans le contexte ci-dessus quand c'est pertinent. Sois direct, concis, actionnable. ` +
        `Donne des paramètres précis quand une valeur est utile (fréquence, ratio, ms, dB). Alternative gratuite possible pour chaque plugin mentionné. ` +
        `Pas de salutation, pas de remerciement, pas de simulation de relation humaine. Tu es un collègue ingé qui brief, pas un ami.\n\n` +
        `FORMATAGE OBLIGATOIRE : tu écris dans un petit panneau de chat intégré à l'app, pas dans un document. ` +
        `Écris en prose naturelle, en paragraphes courts. INTERDIT d'utiliser des titres (#), des tableaux, des listes à puces, des séparateurs (---), ou du gras (**). ` +
        `Pas de markdown du tout. Écris comme un collègue qui parle normalement dans un chat. ` +
        `Si tu dois lister des valeurs, intègre-les dans tes phrases (ex: "vise un pre-delay autour de 25 ms et un high-cut à 7 kHz").`
      );
      system = parts.join(' ');
    } else {
      // Fallback rétrocompatibilité : ancien chat "per item" du drawer (toujours en prod sur decode-app).
      system = `Tu es l'assistant Decode, expert production musicale. DAW: ${daw || 'Logic Pro'}. Élément: ${item?.label || ''}. ${item?.detail || ''} ${fadrData ? `BPM: ${fadrData.bpm}, Tonalité: ${fadrData.key}` : ''} Réponds en français, paramètres précis, alternative gratuite pour chaque plugin.`;
    }

    return res.json({ reply: await chat(messages, system) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
