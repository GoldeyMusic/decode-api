const fetch = require('node-fetch');
const MODEL = 'claude-sonnet-4-6';

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

// ─────────────────────────────────────────────────────────────
// formulatePerception — Phase A du pipeline intention.
// Court (1-2 phrases + 3-5 tags) : on decrit CE qu on entend,
// SANS juger. Cette perception est affichee a l utilisateur sur
// l ecran d intention avant le diagnostic calibre.
// ─────────────────────────────────────────────────────────────
async function formulatePerception(listening) {
  if (!listening) {
    // Ecoute indisponible : on renvoie une perception neutre
    // pour que le front puisse quand meme afficher l ecran intention.
    return {
      lead: "Ecoute qualitative indisponible — dis-moi quand meme ton intention avant le diagnostic.",
      tags: [],
      bpm: null,
      duration: null,
    };
  }

  const listeningStr = JSON.stringify(listening, null, 2);

  const systemPrompt = `Tu es ingenieur du son. Tu recois une ECOUTE qualitative (JSON) faite par un collegue qui a reellement ecoute le morceau.

Ta tache : formuler en 1-2 phrases UNE PERCEPTION courte de ce que tu entends, destinee a etre montree a l artiste avant le diagnostic. Objectif : qu il se reconnaisse, et puisse te corriger ou completer.

REGLES DE TON :
- 1 a 2 phrases, francais naturel, direct.
- Mentionne le style approximatif, le tempo ressenti, 1-2 elements sonores marquants (voix, grain, reverb, choix rythmiques).
- PAS de jugement ("c est bien", "ca manque de"), PAS de score, PAS de "il faudrait".
- PAS de simulation relationnelle ("je sens que tu voulais", "j adore ce que tu fais"). Reste factuel.
- PAS de "chantier" — prefere "ajustements", "leviers", "axes" si tu dois mentionner des pistes.

EN PLUS de la perception, extrais :
- 3 a 5 tags courts en francais (style, grain, tempo, un element fort), format court (ex: "soul-pop", "voix-retrait", "grain-analogique").
- bpm approximatif (number ou null si l ecoute ne permet pas d estimer).
- duree au format "mm:ss" (ou null).

Reponds UNIQUEMENT en JSON valide, sans markdown, sans backticks :
{
  "lead": "string (1-2 phrases)",
  "tags": ["string", "string", ...],
  "bpm": number | null,
  "duration": "mm:ss" | null
}`;

  const prompt = `ECOUTE QUALITATIVE :
${listeningStr}

Formule la perception en suivant exactement le schema JSON ci-dessus.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
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
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeout);
    if (fetchErr.name === 'AbortError') throw new Error('Perception API: timeout (30s)');
    throw fetchErr;
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[perception] API error:', res.status, body.slice(0, 300));
    throw new Error('Perception API: ' + res.status);
  }

  const data = await res.json();
  let text = (data.content[0].text || '').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[perception] no JSON in response');
    return { lead: text.slice(0, 280) || "Lecture formulee indisponible.", tags: [], bpm: null, duration: null };
  }
  try {
    const parsed = JSON.parse(match[0]);
    return {
      lead: typeof parsed.lead === 'string' ? parsed.lead.trim() : "",
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter(t => typeof t === 'string').slice(0, 5) : [],
      bpm: typeof parsed.bpm === 'number' ? parsed.bpm : null,
      duration: typeof parsed.duration === 'string' ? parsed.duration : null,
    };
  } catch (e) {
    console.error('[perception] parse error:', e.message);
    return { lead: "Lecture formulee indisponible.", tags: [], bpm: null, duration: null };
  }
}

// ─────────────────────────────────────────────────────────────
// generateFiche — signature inchangee, avec UN NOUVEAU PARAMETRE
// OPTIONNEL `intent` en fin. Si fourni, injecte un bloc dans le
// system prompt qui cadre le diagnostic sur l intention declaree.
// Tous les appels existants (sans intent) continuent de marcher.
// ─────────────────────────────────────────────────────────────
async function generateFiche(mode, daw, title, artist, listening, pmContext, previousFiche, intent) {
  const isRef = mode === 'ref';
  const listeningStr = listening ? JSON.stringify(listening, null, 2) : 'AUCUNE ECOUTE DISPONIBLE (Gemini a echoue).';
  const hasPM = typeof pmContext === 'string' && pmContext.trim().length > 0;
  const hasIntent = typeof intent === 'string' && intent.trim().length > 0;
  const intentStr = hasIntent ? intent.trim() : '';

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
      { p: "HIGH", task: "titre court du chantier", daw: "instruction concrete en une phrase pour " + daw, metered: "ce que l ecoute observe (ou vide)", target: "direction cible en mots", linkedItemIds: ["voice-1"] }
    ],
    globalScore: 72,
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
    summary: "..."
  });

  // Bloc intention a injecter dans le systemPrompt (seulement si fournie)
  const intentBlock = hasIntent ? `

INTENTION ARTISTIQUE DECLAREE PAR L ARTISTE :
"${intentStr}"

Cette intention est un CADRE qui transforme ton regard :
- Ce qui ressemble a un defaut mais s inscrit dans l intention est un CHOIX ASSUME, pas une erreur. Ne propose pas de le "corriger", sauf si tu penses que le choix dessert l intention elle-meme (et dans ce cas, explique le conflit dans le detail/target).
- Ce qui s ecarte de l intention sans raison apparente merite un item ou une tache d ajustement, avec score bas si c est bien un defaut technique.
- Les references citees (artistes, albums) sont des boussoles : compare, ne copie pas.
- Les scores restent ancres sur les problematiques techniques (balance, dynamique, masquage, artefacts). Un choix revendique par l intention ne doit PAS tirer un score vers le bas.
- Le summary doit brievement reconnaitre l intention et dire si elle est globalement respectee ou si des ecarts notables sont reperes.
` : '';

  const systemPrompt = `Tu es ingenieur du son expert. Tu recois:
1. Une ECOUTE qualitative du morceau (JSON) faite par un collegue qui l a vraiment ecoute. C est ta source primaire sur CE morceau.
${hasPM ? '2. Des EXTRAITS DE COURS PUREMIX (transcripts d ingenieurs de mix reels) pertinents pour les problematiques evoquees par l ecoute. Tu peux t en inspirer pour ta pensee et ton vocabulaire, mais ne les cite jamais verbatim et ne les attribue pas nominativement.' : ''}${intentBlock}

Ton role: transformer tout ca en fiche structuree pour ${daw}, ET ${isRef ? 'un set de conseils de reproduction' : 'un plan d actions concretes'}.

REGLES DE FER:
- L ECOUTE est la SOURCE DE VERITE sur ce morceau. Tu n as AUCUNE mesure (pas de BPM, pas de LUFS, pas de tonalite). Ne mentionne jamais de valeurs mesurees.
- NE CONTREDIS PAS l ecoute. Si l ecoute ne parle pas de voix, n invente pas d item voix. Si l ecoute dit "mix instrumental", la categorie VOIX reste vide (items: []).
- N AJOUTE un item QUE si l ecoute a observe quelque chose de concret dans cette zone. Pas de remplissage generique.
- La categorie VOIX inclut aussi bien les leads que les choeurs/backing vocals. Precise de quelle voix tu parles quand c est utile.
- Une categorie d elements peut etre VIDE (items: []). C est acceptable et souvent correct.
${hasPM ? '- Les extraits PureMix t enrichissent la REFLEXION, pas le contenu. Reformule avec tes propres mots. Ne copie pas de phrases. Ne cite pas "PureMix" ni le nom d un ingenieur. Utilise-les pour mieux formuler les techniques, les priorites de mix, les reflexes pros.' : ''}
- Chaque item.detail doit s appuyer sur une observation de l ecoute.
- ${isRef ? 'tips = 3-5 conseils concrets pour reproduire ce son dans ' + daw : 'plan = UNIQUEMENT les vrais chantiers identifies par l ecoute. Si l ecoute dit que le mix est deja pret, le plan peut etre tres court (1-2 items) ou ne contenir que des ajustements de master. Ne fabrique pas de chantier pour remplir.'}
- "tools" doit contenir des techniques (ex: "Sidechain basse-kick", "EQ soustractif 200-400Hz", "Compression parallele"), pas des noms de plugins.
- ${!isRef ? 'Pour plan: chaque item DOIT avoir les champs suivants en STRING PURE (pas d objet imbrique): "p" (HIGH/MED/LOW), "task" (titre court), "daw" (instruction concrete pour ' + daw + ' en une phrase), "metered" (ce que l ecoute observe ou ""), "target" (direction cible en mots), "linkedItemIds" (array des ids des items d elements qui motivent cette tache).' : ''}
- summary = 1-2 phrases reprenant le verdict de l ecoute avec les priorites concretes. Meme ton direct et pro que l ecoute. INTERDIT de simuler une relation humaine: pas de "merci", "content de t entendre", "j adore", ni aucune marque d emotion personnelle. Reste un collegue ingenieur qui brief, pas un ami qui fait des compliments.

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

REGLE CRITIQUE — CHOIX ARTISTIQUES vs DEFAUTS TECHNIQUES:
- Distingue TOUJOURS les defauts techniques objectifs (saturation non voulue, desequilibre frequentiel, masquage, artefacts) des choix artistiques potentiellement voulus (fin abrupte, arrangement minimal, distorsion creative, structure non conventionnelle, absence d intro/outro, repetition voulue).
- Un choix artistique ne doit JAMAIS etre penalise dans le score comme un defaut. Si l ecoute releve quelque chose qui POURRAIT etre un choix delibere (fin abrupte, arrangement atypique, mix lo-fi, etc.), tu peux le mentionner comme suggestion/alternative dans le detail, mais le score doit rester neutre ou positif (7+). Formule-le comme "Si c est voulu, c est un parti pris defendable. Sinon, on pourrait envisager..." et non comme une erreur a corriger.
- Seuls les problemes techniques objectifs (equilibre spectral, dynamique, nettete, separation des sources, artefacts) justifient un score bas.
- En cas de doute sur l intentionnalite, presume que c est voulu et note en consequence.${hasIntent ? ' L INTENTION DECLAREE en debut de prompt leve deja le doute sur plusieurs aspects : respecte-la.' : ''}

- Champ "globalScore" (entier 0-100) au niveau racine : evaluation globale du mix. Ce n est PAS forcement la moyenne des items. Un mix avec quelques items faibles peut rester a 70 si l essentiel fonctionne. Fais ton jugement en cherchant a refleter l impression generale de l ecoute.
` : ''}
- Reponds UNIQUEMENT en JSON valide. Pas de markdown, pas de backticks.`;

  const prompt = `ECOUTE QUALITATIVE (source primaire):
${listeningStr}

${hasPM ? `EXTRAITS PUREMIX (contexte d ingenieurs de mix, pour enrichir ta reflexion):
${pmContext}
` : ''}MORCEAU: "${title}"${artist ? ' — ' + artist : ''}
DAW utilisateur: ${daw}
MODE: ${isRef ? 'reference a reproduire' : 'diagnostic de mix perso'}${hasIntent ? `
INTENTION DECLAREE: "${intentStr}"` : ''}

Produis le JSON de fiche en suivant exactement cette structure (conserve les "cat" et "icon", varie uniquement le contenu des items${!isRef ? ', du plan, les scores et le globalScore' : ''}):

${isRef ? refTemplate : persoTemplate}

Rappel: categories vides autorisees (items: []). ${isRef ? '' : 'Plan minimaliste autorise si l ecoute est positive. Scores ancres dans le verdict de l ecoute.'} Reprends le ton et le verdict de l ecoute dans le summary.${hasPM ? ' Inspire-toi des extraits PureMix pour affiner la formulation, sans jamais les citer.' : ''}${hasIntent ? ' Tiens compte de l intention declaree : les choix qui en decoulent ne sont pas des defauts.' : ''}`;

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

  // On expose l intention utilisee dans la fiche pour que le front puisse
  // l afficher tel quel (badge "Intention declaree : ...") sans avoir a re-requeter.
  if (hasIntent) parsed.intent_used = intentStr;

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

module.exports = { generateFiche, chat, formulatePerception };
