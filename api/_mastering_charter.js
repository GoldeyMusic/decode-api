// VERSIONS — Endpoint /api/mastering-charter
//
// Génère une charte mastering personnalisée pour un track donné. Appelé
// par le chat de fiche d'analyse au tout premier ouverture (seed message).
//
// Croise :
//   • la charte mastering de référence (lib/masteringCharterReference.js)
//   • le contexte du track : titre, version, BPM, key, LUFS mesuré, genre,
//     uploadType (mix vs master)
//   • la fiche d'analyse (verdict de sortie, blockers, score global,
//     items de diagnostic top-N)
//   • l'écoute qualitative (résumé Gemini)
//   • les chunks PureMix les plus pertinents pour le mastering du track
//     (RAG via lib/rag.js, requête orientée mastering/loudness/limiter)
//
// Sortie : un seul gros message assistant rédigé par Claude, qui pose la
// situation du track puis adapte la charte à son cas concret.

const express = require('express');
const { chat } = require('../lib/claude');
const { getReference } = require('../lib/masteringCharterReference');
const router = express.Router();

let retrievePureMixContext, formatContextForPrompt;
try {
  const rag = require('../lib/rag');
  retrievePureMixContext = rag.retrievePureMixContext;
  formatContextForPrompt = rag.formatContextForPrompt;
} catch (e) {
  console.warn('[mastering-charter] RAG indisponible:', e.message);
}

// Construit un sous-objet listening enrichi avec des termes mastering-
// spécifiques pour orienter le RAG vers les bons chunks PureMix
// (limiteur, loudness, true peak, headroom, master bus, pré-master).
function buildMasteringRagInput(listening) {
  const masteringHint =
    'mastering loudness LUFS true peak limiter headroom master bus pré-master maximizer';
  if (!listening) return { summary: masteringHint, observations: [masteringHint] };
  return {
    impression: listening.impression || '',
    points_forts: listening.points_forts || [],
    a_travailler: listening.a_travailler || [],
    signatures: [...(listening.signatures || []), masteringHint],
    espace: listening.espace || '',
    dynamique: listening.dynamique || '',
    couleur: listening.couleur || '',
    mood: listening.mood || '',
  };
}

router.post('/', async (req, res) => {
  try {
    const {
      locale,
      title,
      version,
      daw,
      genre,
      uploadType,
      dspMetrics,
      listening,
      fiche,
    } = req.body;

    const isEn = (locale || 'fr').toString().toLowerCase().slice(0, 2) === 'en';
    const reference = getReference(isEn ? 'en' : 'fr');

    // Bloc contexte du track — concis, structuré pour Claude
    const ctx = [];
    if (title) ctx.push(`Titre : "${title}"${version ? ` (${version})` : ''}`);
    if (genre) ctx.push(`Genre déclaré : ${genre}`);
    if (uploadType) {
      ctx.push(
        `Type d'upload : ${uploadType === 'mix' ? 'MIX (avant mastering)' : 'MASTER (déjà masterisé)'}`
      );
    }
    if (daw) ctx.push(`DAW : ${daw}`);
    if (dspMetrics) {
      const { bpm, key, lufs } = dspMetrics;
      if (bpm) ctx.push(`BPM : ${bpm}`);
      if (key) ctx.push(`Tonalité : ${key}`);
      if (lufs) ctx.push(`LUFS intégré mesuré : ${lufs}`);
    }

    // Verdict de sortie + bloquants — extraits ciblés de la fiche pour
    // ne pas saturer le system prompt avec tout le JSON. La fiche
    // d'analyse Versions a la structure :
    //   { globalScore, elements: [{ cat, items: [{ priority, title, score, why, how }] }], verdict, ... }
    // On flatten les items et on garde les plus faibles + ceux flaggés
    // high priority (qui sont les bloquants potentiels).
    const ficheDigest = (() => {
      if (!fiche) return null;
      const digest = {};
      if (fiche.globalScore != null) digest.globalScore = fiche.globalScore;
      // Releaseiness peut être passé directement par le front (déjà calculé)
      if (fiche.releaseReadiness) digest.releaseReadiness = fiche.releaseReadiness;
      if (fiche.verdict) {
        digest.verdict =
          typeof fiche.verdict === 'string'
            ? fiche.verdict.slice(0, 600)
            : {
                mainstream: (fiche.verdict.mainstream || '').slice(0, 400),
                technical: (fiche.verdict.technical || '').slice(0, 400),
              };
      }
      // Bloquants explicites (si front les a calculés via computeReleaseReadiness)
      if (Array.isArray(fiche.blockers) && fiche.blockers.length) {
        digest.blockers = fiche.blockers.slice(0, 6);
      }
      // Flatten elements → items, trier par score ascendant, garder top 6
      const flatItems = [];
      if (Array.isArray(fiche.elements)) {
        fiche.elements.forEach((el) => {
          const cat = el?.cat || el?.id || '';
          (Array.isArray(el?.items) ? el.items : []).forEach((it) => {
            if (!it) return;
            flatItems.push({
              cat,
              title: it.title || it.label || '',
              score: typeof it.score === 'number' ? it.score : null,
              priority: (it.priority || '').toString().toLowerCase(),
              why: (it.why || '').slice(0, 220),
              how: (it.how || '').slice(0, 220),
            });
          });
        });
      } else if (Array.isArray(fiche.items)) {
        fiche.items.forEach((it) => {
          flatItems.push({
            cat: it.cat || it.category || '',
            title: it.title || it.label || '',
            score: typeof it.score === 'number' ? it.score : null,
            priority: (it.priority || '').toString().toLowerCase(),
            why: (it.why || '').slice(0, 220),
            how: (it.how || '').slice(0, 220),
          });
        });
      }
      if (flatItems.length) {
        // Items les plus problématiques d'abord (high priority puis score ascendant)
        flatItems.sort((a, b) => {
          const ha = a.priority === 'high' ? 0 : 1;
          const hb = b.priority === 'high' ? 0 : 1;
          if (ha !== hb) return ha - hb;
          return (a.score ?? 100) - (b.score ?? 100);
        });
        digest.diagnosticTop = flatItems.slice(0, 6);
      }
      return digest;
    })();

    // RAG PureMix — chunks orientés mastering
    let pmContext = '';
    if (retrievePureMixContext) {
      try {
        const ragInput = buildMasteringRagInput(listening);
        const chunks = await retrievePureMixContext(ragInput, { matchCount: 5 });
        if (chunks && chunks.length) {
          pmContext = formatContextForPrompt(chunks) || '';
        }
      } catch (err) {
        console.warn('[mastering-charter] RAG error:', err.message);
      }
    }

    const localeInstruction = isEn
      ? 'LANGUAGE OF OUTPUT: respond entirely in ENGLISH. Do not switch languages mid-message.\n\n'
      : '';

    const promptParts = [
      `Tu es l'assistant Versions, ingénieur du son expert intégré dans une app d'analyse de production musicale. Tu rédiges UN SEUL message structuré qui sera affiché comme premier message du chat d'une fiche d'analyse — c'est l'utilisateur qui vient de cliquer "Conseils mastering ?" et tu dois lui donner les normes mastering pertinentes pour SON track spécifiquement.`,
      ``,
      `--- CONTEXTE DU TRACK ---`,
      ctx.length ? ctx.join('\n') : '(pas de contexte précis fourni)',
    ];
    if (listening) {
      promptParts.push(``, `--- ÉCOUTE QUALITATIVE ---`, JSON.stringify(listening, null, 2));
    }
    if (ficheDigest) {
      promptParts.push(
        ``,
        `--- FICHE D'ANALYSE (verdict + diagnostic) ---`,
        JSON.stringify(ficheDigest, null, 2)
      );
    }
    if (pmContext) {
      promptParts.push(
        ``,
        `--- EXTRAITS PUREMIX (transcripts d'ingénieurs de mix réels) ---`,
        pmContext,
        ``,
        `Ces extraits viennent d'ingénieurs pro. Tu peux t'en inspirer pour enrichir tes conseils, mais ne les cite jamais verbatim et ne les attribue pas nominativement. Reformule avec tes propres mots.`
      );
    }
    promptParts.push(
      ``,
      `--- CHARTE MASTERING DE RÉFÉRENCE (base de connaissances à adapter) ---`,
      reference,
      ``,
      `--- INSTRUCTIONS DE RÉDACTION ---`,
      `1. Tu écris UN SEUL message structuré (~600-900 mots), pas une conversation. Format markdown léger autorisé : gras **, puces •, sauts de ligne — c'est le seul message qui aura ce format, les réponses suivantes seront en prose.`,
      `2. Commence par 2-3 phrases de LECTURE DU TRACK : pose la situation actuelle en t'appuyant sur les chiffres mesurés (LUFS si dispo, BPM, genre) et le verdict de sortie. Ex : "Sur ton track [titre], avec un genre [genre] à [BPM] BPM mesuré actuellement à [LUFS], le verdict de sortie te place [ready/almost/not-yet]..."`,
      `3. Donne ENSUITE les cibles mastering pertinentes en PRIORISANT les destinations probables selon le genre (techno → club + streaming en priorité ; folk/indie → streaming + vinyle ; pop mainstream → streaming + RS ; etc.). Ne récite pas les 7 destinations en bloc — sélectionne les 2-4 qui s'appliquent vraiment à ce track.`,
      `4. Croise avec les BLOQUANTS du verdict de sortie : si la fiche pointe un problème de loudness, de headroom, de basses mono, de transitoires écrasées → traite-le comme un point bloquant pour le mastering et donne le tip concret pour le résoudre.`,
      `5. Intègre 2-4 tips ACTIONABLES qui sortent du diagnostic ET/OU des extraits PureMix (si tu en as). Pas de banalités — chaque tip doit être contextuel à CE track.`,
      `6. Si le track est uploadé comme MIX (uploadType='mix'), oriente clairement vers le pré-mastering (chaîne master bus, headroom à viser, true peak du fichier livré au mastering). Si c'est un MASTER (uploadType='master'), audite directement le master livré.`,
      `7. Termine par UNE question contextuelle pour inviter à creuser : "Tu veux qu'on creuse [point spécifique pertinent au track] ?". Pas une formule générique.`,
      `8. Pas de salutation, pas de "voici tes recommandations", pas de simulation de relation humaine. Tu es un collègue ingé qui briefe sur le mastering de ce track précis.`,
      `9. Si tu manques d'info (LUFS non mesuré, genre absent), dis-le simplement ("le LUFS n'est pas remonté ici, mais...") et reste utile.`
    );

    const system = localeInstruction + promptParts.join('\n');

    const userMsg = isEn
      ? "Give me your personalized mastering charter for this track."
      : "Donne-moi ta charte mastering personnalisée pour ce track.";

    const reply = await chat([{ role: 'user', content: userMsg }], system);

    return res.json({ reply });
  } catch (err) {
    console.error('[mastering-charter] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
