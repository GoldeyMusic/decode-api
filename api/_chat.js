const express = require('express');
const { chatWithUsage, MODEL } = require('../lib/claude');
const { logChatCost } = require('../lib/costTracker');
const router = express.Router();

// Tente de charger le RAG PureMix (peut ne pas exister dans tous les envs)
let retrievePureMixContext, formatContextForPrompt;
try {
  const rag = require('../lib/rag');
  retrievePureMixContext = rag.retrievePureMixContext;
  formatContextForPrompt = rag.formatContextForPrompt;
} catch (e) {
  console.warn('[chat] RAG PureMix indisponible:', e.message);
}

// Estimation grossière du nombre de tokens consommés par OpenAI pour
// l'embedding de la requête. text-embedding-3-small ne renvoie pas le
// usage, donc on estime à 4 chars/token (heuristique standard EN/FR).
function estimateEmbedTokens(query) {
  if (!query) return 0;
  return Math.ceil(query.length / 4);
}

router.post('/', async (req, res) => {
  try {
    const {
      messages, item, daw, fadrData, listening, fiche,
      title, artist, version,
      userId = null, versionId = null,
    } = req.body;
    if (!messages) return res.status(400).json({ error: 'messages required' });

    const locale = (req.body.locale || 'fr').toString().toLowerCase().slice(0, 2);
    const isEn = locale === 'en';
    // Bloc "réponds en langue X" préfixé au system prompt.
    const chatLocaleInstruction = isEn
      ? `LANGUAGE OF OUTPUT: respond entirely in ENGLISH. Do not switch languages mid-message.\n\n`
      : '';

    // ─────────────────────────────────────────────────────────────
    // Mode "version-wide" (chat de fiche) : prompt caching activé.
    //
    // On découpe le system prompt en blocs ordonnés du PLUS STATIQUE
    // au PLUS VOLATILE. Les 3 premiers blocs sont marqués cache_control
    // ephemeral → réutilisés tant que la fiche/l'écoute ne changent pas
    // (TTL 5 min, renouvelé à chaque hit). Les blocs RAG + closing
    // ne sont pas cachés car ils varient par question.
    //
    // Limite Anthropic : 4 cache_control markers par requête. On en utilise 3.
    // ─────────────────────────────────────────────────────────────
    let systemPayload;
    let ragUsed = false;
    let embedTokens = 0;

    if (listening || fiche) {
      // Bloc 1 — charter assistant Versions. Statique, change rarement.
      const charterText = chatLocaleInstruction +
        `Tu es l'assistant Versions, ingénieur du son expert (20+ ans d'expérience), intégré dans une app d'analyse de production musicale.\n` +
        `DAW de l'utilisateur : ${daw || 'Logic Pro'}.\n\n` +
        `FORMATAGE OBLIGATOIRE : tu écris dans un petit panneau de chat intégré à l'app, pas dans un document. ` +
        `Écris en prose naturelle, en paragraphes courts. INTERDIT d'utiliser des titres (#), des tableaux, des listes à puces, des séparateurs (---), ou du gras (**). ` +
        `Pas de markdown du tout. Écris comme un collègue qui parle normalement dans un chat. ` +
        `Si tu dois lister des valeurs, intègre-les dans tes phrases (ex: "vise un pre-delay autour de 25 ms et un high-cut à 7 kHz").\n\n` +
        `Sois direct, concis, actionnable. Donne des paramètres précis quand une valeur est utile (fréquence, ratio, ms, dB). ` +
        `Alternative gratuite possible pour chaque plugin mentionné. ` +
        `Pas de salutation, pas de remerciement, pas de simulation de relation humaine. Tu es un collègue ingé qui brief, pas un ami.`;

      // Bloc 2 — meta du morceau (titre, artiste, version). Stable pendant la conv.
      const metaParts = [];
      if (title) metaParts.push(`Morceau actuellement analysé : "${title}"${artist ? ' — ' + artist : ''}.`);
      if (version) metaParts.push(`Version affichée : ${version}.`);
      const metaText = metaParts.length > 0 ? metaParts.join('\n') : '(pas de métadonnées de morceau)';

      // Bloc 3 — fiche + écoute (gros JSON, ~le plus gros morceau du prompt). Stable pendant la conv.
      const ficheBlock = [];
      if (listening) ficheBlock.push(`--- ÉCOUTE QUALITATIVE DE CE MORCEAU ---\n${JSON.stringify(listening, null, 2)}`);
      if (fiche) ficheBlock.push(`--- FICHE D'ANALYSE ACTUELLE (diagnostic + plan d'action) ---\n${JSON.stringify(fiche, null, 2)}`);
      const ficheText = ficheBlock.join('\n\n') || '(pas de fiche disponible)';

      // Bloc 4 — RAG PureMix. Varie à chaque message → JAMAIS caché.
      let ragText = '';
      if (retrievePureMixContext && listening) {
        try {
          const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
          const query = lastUserMsg?.content || lastUserMsg?.text || '';
          const ragInput = query
            ? { summary: query, observations: [query] }
            : listening;
          embedTokens = estimateEmbedTokens(query || JSON.stringify(ragInput).slice(0, 500));
          const pmChunks = await retrievePureMixContext(ragInput);
          if (pmChunks && pmChunks.length > 0) {
            const pmContext = formatContextForPrompt(pmChunks);
            if (pmContext) {
              ragUsed = true;
              ragText =
                `\n\n--- EXTRAITS DE COURS PUREMIX (transcripts d'ingénieurs de mix réels) ---\n${pmContext}\n` +
                `Ces extraits viennent d'ingénieurs de mix professionnels. Tu peux t'en inspirer pour enrichir ta réponse, ` +
                `mais ne les cite jamais verbatim et ne les attribue pas nominativement. Reformule avec tes propres mots.\n\n` +
                `L'utilisateur te pose des questions sur ce morceau, cette analyse, ou la production en général. ` +
                `Ancre tes réponses dans le contexte ci-dessus quand c'est pertinent.`;
            }
          }
        } catch (err) {
          console.warn('[chat] RAG PureMix error:', err.message);
        }
      }
      if (!ragText) {
        ragText = `\n\nL'utilisateur te pose des questions sur ce morceau, cette analyse, ou la production en général. ` +
          `Ancre tes réponses dans le contexte ci-dessus quand c'est pertinent.`;
      }

      // System payload en BLOCS — les 3 premiers sont cachables.
      // L'ordre est critique : Anthropic cache jusqu'au DERNIER bloc marqué cache_control,
      // donc on les empile du plus statique au plus volatile, et on n'en marque que les
      // statiques. Le bloc RAG (volatile) arrive après et n'est pas marqué.
      systemPayload = [
        { type: 'text', text: charterText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: metaText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: ficheText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: ragText },
      ];
    } else {
      // Fallback rétrocompat : ancien chat "per item" du drawer (peu utilisé).
      // Pas de caching ici (prompt trop court pour bénéficier du cache).
      const langDirective = isEn ? 'Respond in English' : 'Réponds en français';
      systemPayload = chatLocaleInstruction +
        `Tu es l'assistant Decode, expert production musicale. DAW: ${daw || 'Logic Pro'}. ` +
        `Élément: ${item?.label || ''}. ${item?.detail || ''} ` +
        `${fadrData ? `BPM: ${fadrData.bpm}, Tonalité: ${fadrData.key}` : ''} ` +
        `${langDirective}, paramètres précis, alternative gratuite pour chaque plugin.`;
    }

    const result = await chatWithUsage(messages, systemPayload);

    // Fire-and-forget : on ne bloque pas la réponse au client si le log échoue.
    // logChatCost ne throw jamais (cf. costTracker.js).
    logChatCost({
      userId,
      versionId,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      ragUsed,
      locale,
      claudeUsage: result.usage,
      embedTokens,
      claudeModel: result.model || MODEL,
    }).catch((e) => console.warn('[chat] logChatCost rejected:', e.message));

    return res.json({ reply: result.reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
