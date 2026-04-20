const fetch = require('node-fetch');
const MODEL = 'claude-sonnet-4-6';

// Instruction de langue injectée en tête de system prompt.
// Les prompts détaillés restent en FR (ils sont calibrés), mais tout le TEXTE
// VISIBLE produit (labels, verdicts, summary, details, tips, plan tasks…)
// doit être généré dans la langue demandée. Les IDs techniques et les clés
// JSON restent évidemment inchangés.
function buildLocaleInstruction(locale) {
  const norm = (locale || '').toString().toLowerCase().slice(0, 2);
  if (norm === 'en') {
    return `LANGUAGE OF OUTPUT (hard rule): produce ALL human-visible string values in ENGLISH — every "label", "detail", "tools", "task", "daw", "metered", "target", "summary", "verdict", "tips" and any other natural-language field.
- JSON keys MUST remain unchanged (they are code identifiers).
- The "icon" field MUST remain unchanged — it is a stable code identifier: keep exactly "voice", "synths", "bass", "drums", "fx", "lufs".
- Technical ids such as "voice-1", "bass-1" MUST remain unchanged.
- For the "cat" field, translate to the English canonical names: "VOICE", "INSTRUMENTS", "BASS & KICK", "DRUMS & PERCUSSION", "SPATIAL & REVERB", "MASTER & LOUDNESS". Use "VOICE" (not "VOCALS") for the voice category — the UI keys on this value.
- For "elements_detectes", keep the family keys exactly "voix", "drums", "basses", "instruments", "spatial" (code identifiers) but translate the listed strings inside the arrays to English.

`;
  }
  // FR est la langue par défaut des prompts — rien à ajouter.
  return '';
}

// Garde-fou post-parse : genere les ids manquants, filtre les linkedItemIds orphelins,
// normalise les scores /10, et calcule un globalScore /100 pondere si absent.
function normalizeIds(fiche) {
  if (!fiche || !Array.isArray(fiche.elements)) return fiche;
  const validIds = new Set();
  // Ponderation par categorie (voix et master pesent plus, drums moins)
  const WEIGHTS = {
    voice: 2,
    lufs: 2,
    bass: 1.5,
    synths: 1,
    fx: 1,
    drums: 0.8,
  };
  let weightedSum = 0;
  let totalWeight = 0;
  for (const el of fiche.elements) {
    if (!Array.isArray(el.items)) continue;
    const prefix = (el.icon || el.cat || 'item').toString().toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'item';
    const w = WEIGHTS[prefix] ?? 1;
    let n = 1;
    for (const it of el.items) {
      if (!it || typeof it !== 'object') continue;
      if (!it.id || typeof it.id !== 'string') it.id = `${prefix}-${n}`;
      if (typeof it.score === 'number' && !Number.isNaN(it.score)) {
        it.score = Math.max(0, Math.min(10, Math.round(it.score)));
        weightedSum += it.score * w;
        totalWeight += w;
      }
      validIds.add(it.id);
      n++;
    }
  }
  if (Array.isArray(fiche.plan)) {
    for (const task of fiche.plan) {
      if (!task || typeof task !== 'object') continue;
      if (!Array.isArray(task.linkedItemIds)) { task.linkedItemIds = []; continue; }
      task.linkedItemIds = task.linkedItemIds.filter(id => typeof id === 'string' && validIds.has(id));
    }
  }
  // globalScore /100 — recalcule si absent ou hors limites
  if (typeof fiche.globalScore !== 'number' || fiche.globalScore < 0 || fiche.globalScore > 100) {
    fiche.globalScore = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) : null;
  } else {
    fiche.globalScore = Math.max(0, Math.min(100, Math.round(fiche.globalScore)));
  }
  return fiche;
}

// Bloc d'instructions injecté dans le system prompt selon le type vocal.
// Contraint Claude à respecter l'intention artistique :
// - 'instrumental_final' : la catégorie VOIX DOIT rester items: [], aucun item
//   de plan ne doit pointer sur la voix, globalScore sans la voix.
// - 'instrumental_pending' : VOIX = étape à venir, pas un manque ; pas d'item
//   de plan critique, pas de score pénalisé.
function buildVocalTypeBlock(vocalType) {
  if (vocalType === 'instrumental_final') {
    return `
TYPE DU MORCEAU : INSTRUMENTAL DEFINITIF (l artiste a valide : pas de voix, et il n y en aura jamais).
- La categorie "VOIX" DOIT imperativement rester items: []. Aucun item de voix.
- Aucun item de plan ne doit concerner la voix (ni task, ni daw, ni metered, ni target, ni linkedItemIds).
- Ne mentionne PAS la voix dans summary ni dans verdict (pas "voix a ajouter", pas "manque une voix").
- Le globalScore se calcule sur l instrumental uniquement : ne penalise JAMAIS ce morceau pour l absence de voix. L oeuvre EST instrumentale.
- Dans elements_detectes, la famille "voix" DOIT etre vide : [].
`;
  }
  if (vocalType === 'instrumental_pending') {
    return `
TYPE DU MORCEAU : INSTRUMENTAL TEMPORAIRE (les voix arriveront sur les prochaines versions).
- La categorie "VOIX" DOIT rester items: [] pour cette version (aucun item critique).
- Aucun item de plan ne doit formuler l absence de voix comme un probleme. Pas de task "enregistrer la voix" dans le plan d ajustement.
- Ne penalise pas le globalScore pour l absence de voix sur cette version : elle est attendue, c est une etape a venir.
- Dans summary et verdict, si tu evoques la voix, fais-le neutrement ("les voix arriveront plus tard") et JAMAIS comme un manque.
- Dans elements_detectes, la famille "voix" DOIT etre vide : [] (pas de voix a detecter sur cette version).
`;
  }
  return '';
}

async function generateFiche(mode, daw, title, artist, listening, pmContext, previousFiche, vocalType, locale) {
  const isRef = mode === 'ref';
  const vocalBlock = buildVocalTypeBlock(vocalType || 'vocal');
  const localeInstruction = buildLocaleInstruction(locale);
  const listeningStr = listening ? JSON.stringify(listening, null, 2) : 'AUCUNE ECOUTE DISPONIBLE (analyse auditive indisponible).';
  const hasPM = typeof pmContext === 'string' && pmContext.trim().length > 0;

  const persoTemplate = JSON.stringify({
    elements: [
      { cat: "VOIX",                icon: "voice",   items: [{ id: "voice-1",   score: 7, label: "...", detail: "...", tools: ["..."] }] },
      { cat: "INSTRUMENTS",         icon: "synths",  items: [] },
      { cat: "BASSES & KICK",       icon: "bass",    items: [] },
      { cat: "DRUMS & PERCUSSIONS", icon: "drums",   items: [] },
      { cat: "SPATIAL & REVERB",    icon: "fx",      items: [] },
      { cat: "MASTER & LOUDNESS",   icon: "lufs",    items: [] },
    ],
    plan: [
      { p: "HIGH", task: "titre court de l'ajustement", daw: "instruction concrete en une phrase pour " + daw, metered: "ce que l ecoute observe (ou vide)", target: "direction cible en mots", linkedItemIds: ["voice-1"] }
    ],
    globalScore: 72,
    elements_detectes: { voix: [], drums: [], basses: [], instruments: [], spatial: [] },
    verdict: "...",
    summary: "..."
  });

  const refTemplate = JSON.stringify({
    elements: [
      { cat: "VOIX",                icon: "voice",   items: [] },
      { cat: "INSTRUMENTS",         icon: "synths",  items: [] },
      { cat: "BASSES & KICK",       icon: "bass",    items: [] },
      { cat: "DRUMS & PERCUSSIONS", icon: "drums",   items: [] },
      { cat: "SPATIAL & REVERB",    icon: "fx",      items: [] },
      { cat: "MASTER & LOUDNESS",   icon: "lufs",    items: [] },
    ],
    tips: [],
    elements_detectes: { voix: [], drums: [], basses: [], instruments: [], spatial: [] },
    verdict: "...",
    summary: "..."
  });

  const systemPrompt = `${localeInstruction}Tu es ingenieur du son expert. Tu recois:
1. Une ECOUTE qualitative du morceau (JSON) faite par un collegue qui l a vraiment ecoute. C est ta source primaire sur CE morceau.
${hasPM ? '2. Des EXTRAITS DE COURS PUREMIX (transcripts d ingenieurs de mix reels) pertinents pour les problematiques evoquees par l ecoute. Tu peux t en inspirer pour ta pensee et ton vocabulaire, mais ne les cite jamais verbatim et ne les attribue pas nominativement.' : ''}

Ton role: transformer tout ca en fiche structuree pour ${daw}, ET ${isRef ? 'un set de conseils de reproduction' : 'un plan d actions concretes'}.

REGLES DE FER:
- L ECOUTE est la SOURCE DE VERITE sur ce morceau. Tu n as AUCUNE mesure (pas de BPM, pas de LUFS, pas de tonalite). Ne mentionne jamais de valeurs mesurees.
- NE CONTREDIS PAS l ecoute. Si l ecoute ne parle pas de voix, n invente pas d item voix. Si l ecoute dit "mix instrumental", la categorie VOIX reste vide (items: []).
- N AJOUTE un item QUE si l ecoute a observe quelque chose de concret dans cette zone. Pas de remplissage generique.
- La categorie VOIX inclut aussi bien les leads que les choeurs/backing vocals. Precise de quelle voix tu parles quand c est utile.
- Une categorie d elements peut etre VIDE (items: []). C est acceptable et souvent correct.
${hasPM ? '- Les extraits PureMix t enrichissent la REFLEXION, pas le contenu. Reformule avec tes propres mots. Ne copie pas de phrases. Ne cite pas "PureMix" ni le nom d un ingenieur. Utilise-les pour mieux formuler les techniques, les priorites de mix, les reflexes pros.' : ''}
- Chaque item.detail doit s appuyer sur une observation de l ecoute.
- ${isRef ? 'tips = 3-5 conseils concrets pour reproduire ce son dans ' + daw : 'plan = UNIQUEMENT les vrais ajustements identifies par l ecoute. Si l ecoute dit que le mix est deja pret, le plan peut etre tres court (1-2 items) ou ne contenir que des ajustements de master. Ne fabrique pas d ajustement pour remplir.'}
- "tools" doit contenir des techniques (ex: "Sidechain basse-kick", "EQ soustractif 200-400Hz", "Compression parallele"), pas des noms de plugins.
- ${!isRef ? 'Pour plan: chaque item DOIT avoir les champs suivants en STRING PURE (pas d objet imbrique): "p" (HIGH/MED/LOW), "task" (titre court), "daw" (instruction concrete pour ' + daw + ' en une phrase), "metered" (ce que l ecoute observe ou ""), "target" (direction cible en mots), "linkedItemIds" (array des ids des items d elements qui motivent cette tache).' : ''}
- summary = 1-2 phrases reprenant le verdict de l ecoute avec les priorites concretes. Meme ton direct et pro que l ecoute. INTERDIT de simuler une relation humaine: pas de "merci", "content de t entendre", "j adore", ni aucune marque d emotion personnelle. Reste un collegue ingenieur qui brief, pas un ami qui fait des compliments.
- VOCABULAIRE INTERDIT: n utilise JAMAIS le mot "chantier" ni ses derives. Dis "ajustement", "retouche", "piste", "levier" ou "axe" selon le contexte. Cette regle s applique au summary, au verdict, aux labels et a tous les champs texte.
- verdict = UNE phrase courte et percutante (max 14 mots) qui capture l impression dominante du morceau. Encadre 1-2 mots-cles forts par des asterisques *ainsi* pour les mettre en valeur (italique ambre). Exemples: "Un mix *presque pret*, il reste deux ajustements precis pour decoller.", "Production *solide* avec une voix qui manque d air.", "Morceau *abouti*, rien a retoucher au-dela du master."

REGLE IDS (obligatoire):
- Chaque item de elements[].items DOIT avoir un champ "id" unique au format "<icon>-<N>", ou <icon> est la valeur du champ "icon" de la categorie parente et <N> un entier qui commence a 1 et s incremente PAR categorie. Exemples: "voice-1", "voice-2", "bass-1", "drums-1", "lufs-1".
${!isRef ? '- Chaque tache de plan[] DOIT avoir un champ "linkedItemIds" de type array. Il contient les ids des items d elements qui motivent cette tache. Plusieurs ids autorises (de plusieurs categories possibles). Tableau vide [] si la tache est purement transverse (ex: master).' : ''}

${!isRef ? `REGLE SCORES (obligatoire en mode diagnostic):
- Chaque item de elements[].items DOIT avoir un champ "score" (entier de 0 a 10) qui evalue l etat actuel de cet aspect du mix.
- Bareme calibre (ni trop severe, ni trop complaisant):
  - 0-3 : probleme majeur qui empeche le titre de fonctionner (voix inaudible, basse qui masque tout, master destructif).
  - 4-5 : defaut audible clair, a traiter pour passer a l etape suivante.
  - 6-7 : correct, pro mais pas encore convaincant, dernieres finitions.
  - 8-9 : tres bon niveau, commercialement defendable.
  - 10 : reference absolue. RARE. Seulement si l ecoute est dithyrambique.
- Ancre les scores STRICTEMENT sur ce que dit l ecoute. Un item existe parce que l ecoute a observe quelque chose : son score reflete ce verdict.
- Evite les scores tous identiques. Si l ecoute distingue forces et faiblesses, les scores doivent le refleter.
- Champ "globalScore" (entier 0-100) au niveau racine : evaluation globale du mix. Ce n est PAS forcement la moyenne des items. Un mix avec quelques items faibles peut rester a 70 si l essentiel fonctionne. Fais ton jugement en cherchant a refleter l impression generale de l ecoute.
` : ''}
- Champ "elements_detectes" (objet, racine) RÈGLE STRICTE : ne liste QUE les elements que l ecoute mentionne EXPLICITEMENT par leur nom dans son texte (impression, points_forts, espace, dynamique, a_travailler). N invente JAMAIS un instrument pour remplir une famille. Si l ecoute ne parle pas de pads, ne mets pas "pads". Si l ecoute ne parle ni de guitare ni de synthe, la famille instruments reste []. Mieux vaut une famille vide qu un element invente. IMPORTANT : cette regle stricte concerne UNIQUEMENT le champ technique elements_detectes (jamais affiche). Pour TOUS les champs affiches (label, detail, summary, verdict, plan, items), garde le ton naturel d ingenieur du son qui parle a un artiste : observations sensibles, formulations vivantes, JAMAIS "j ai detecte", "non detecte", "absent", "present" ou tout vocabulaire de detection automatique. Tu decris ce que TU entends comme un humain qui ecoute, pas comme un script qui scanne. Avant de lister un element, verifie qu il apparait textuellement dans l ecoute. Description ci-apres : liste EXHAUSTIVE des elements musicaux que l ecoute mentionne ou implique avoir entendus, regroupes par famille (voix, drums, basses, instruments, spatial). Inclut TOUT ce qui est present meme sans probleme a traiter (ex: "kick", "caisse claire", "choeurs", "pad", "guitare clean"). Ce champ sert UNIQUEMENT a comparer des versions entre elles (detecter ajouts/retraits) et n est jamais affiche. Si l ecoute ne mentionne pas un element, ne l invente pas. Famille absente = tableau vide [].
- Reponds UNIQUEMENT en JSON valide. Pas de markdown, pas de backticks.
${vocalBlock}`;

  const calibrationStr = previousFiche ? "REFERENCE — FICHE DE LA VERSION PRECEDENTE DU MEME TITRE (point d ancrage uniquement, PAS un modele a copier) :\n" + JSON.stringify(previousFiche, null, 2) + "\n\nUTILISATION DE CETTE REFERENCE :\n- Ta source de verite reste l ECOUTE QUALITATIVE actuelle. La fiche precedente sert seulement a EVITER une derive aleatoire des scores quand l ecoute ne signale aucun changement.\n- Scores : si l ecoute decrit un vrai changement (amelioration ou degradation) sur un element, fais bouger franchement le score (1 a 4 points). Si l ecoute ne signale rien sur un element, le score reste proche du precedent.\n- elements_detectes : derive ta liste de l ECOUTE actuelle. Ne recopie pas aveuglement la liste precedente. Si l ecoute confirme un ajout/retrait (chœurs, instrument), reflete-le.\n- plan : refais-le selon l ecoute actuelle. Si un probleme passe est resolu, ne le remets pas. Si un nouveau probleme apparait, ajoute-le.\n- globalScore : peut bouger librement si l ecoute le justifie. La reference sert juste a eviter une variation de 15+ points sans changement audible.\n\n" : "";
  const prompt = `ECOUTE QUALITATIVE (source primaire):
${listeningStr}

${hasPM ? `EXTRAITS PUREMIX (contexte d ingenieurs de mix, pour enrichir ta reflexion):
${pmContext}
` : ""}${calibrationStr}MORCEAU: "${title}"${artist ? ' — ' + artist : ''}
DAW utilisateur: ${daw}
MODE: ${isRef ? 'reference a reproduire' : 'diagnostic de mix perso'}

Produis le JSON de fiche en suivant exactement cette structure (conserve les "cat" et "icon", varie uniquement le contenu des items${!isRef ? ', du plan, les scores et le globalScore' : ''}):

${isRef ? refTemplate : persoTemplate}

Rappel: categories vides autorisees (items: []). ${isRef ? '' : 'Plan minimaliste autorise si l ecoute est positive. Scores ancres dans le verdict de l ecoute.'} Reprends le ton et le verdict de l ecoute dans le summary.${hasPM ? ' Inspire-toi des extraits PureMix pour affiner la formulation, sans jamais les citer.' : ''}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeout);
    if (fetchErr.name === 'AbortError') throw new Error('Analysis API: timeout (120s)');
    throw fetchErr;
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[claude] API error:', res.status, body.slice(0, 300));
    throw new Error('Analysis API: ' + res.status);
  }

  const data = await res.json();
  let text = data.content[0].text.trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON in response');

  let depth = 0, end = -1, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }

  if (end === -1) {
    console.warn('[claude] JSON truncated, attempting repair...');
    let repair = text.slice(start);
    repair = repair.replace(/,\s*"[^"]*":\s*"[^"]*$/, '');
    repair = repair.replace(/,\s*"[^"]*$/, '');
    const openBraces = (repair.match(/\{/g) || []).length - (repair.match(/\}/g) || []).length;
    const openBrackets = (repair.match(/\[/g) || []).length - (repair.match(/\]/g) || []).length;
    for (let i = 0; i < openBrackets; i++) repair += ']';
    for (let i = 0; i < openBraces; i++) repair += '}';
    text = repair;
  } else {
    text = text.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error('[claude] parse error:', e.message, text.slice(0, 500));
    throw new Error('JSON invalide: ' + e.message);
  }

  // Normalisation defensive: si Claude imbrique p.daw comme objet, on extrait la string
  if (Array.isArray(parsed.plan)) {
    parsed.plan = parsed.plan.map((p) => {
      const out = { ...p };
      if (out.daw && typeof out.daw === 'object') {
        const vals = Object.values(out.daw).filter((v) => typeof v === 'string');
        out.daw = vals.join(' ').trim() || '';
      }
      if (out.task && typeof out.task === 'object') {
        const vals = Object.values(out.task).filter((v) => typeof v === 'string');
        out.task = vals.join(' ').trim() || '';
      }
      if (out.metered && typeof out.metered === 'object') out.metered = '';
      if (out.target && typeof out.target === 'object') out.target = '';
      return out;
    });
  }

  // Garde-fou ids/linkedItemIds/scores/globalScore
  return normalizeIds(parsed);
}

async function chat(messages, system) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, system, messages }),
  });
  if (!res.ok) throw new Error('Chat API: ' + res.status);
  return (await res.json()).content[0].text;
}

module.exports = { generateFiche, chat, buildLocaleInstruction };
