const fetch = require('node-fetch');
const MODEL = 'claude-sonnet-4-6';

// Garde-fou post-parse : genere les ids manquants, normalise les scores /100,
// et calcule un globalScore /100 pondere si absent.
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
        it.score = Math.max(0, Math.min(100, Math.round(it.score)));
        weightedSum += it.score * w;
        totalWeight += w;
      }
      validIds.add(it.id);
      n++;
    }
  }
  // globalScore /100 — recalcule si absent ou hors limites.
  // Les scores items sont desormais /100, donc moyenne ponderee directe (plus de *10).
  if (typeof fiche.globalScore !== 'number' || fiche.globalScore < 0 || fiche.globalScore > 100) {
    fiche.globalScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
  } else {
    fiche.globalScore = Math.max(0, Math.min(100, Math.round(fiche.globalScore)));
  }
  return fiche;
}

// ─────────────────────────────────────────────────────────────
// Score floor protection (ticket 4.1).
//
// Quand on revise un mix, le globalScore ne peut pas perdre plus de 3 points
// par rapport a la version precedente, et chaque categorie (sub-score) ne
// peut pas perdre plus de 5 points sur sa moyenne. Si la nouvelle moyenne
// d une categorie tombe sous le plancher, on releve uniformement les
// item.score de la categorie pour ramener la moyenne au plancher (le front
// recalcule la moyenne a partir des items, donc cette correction suffit).
//
// Reponse directe au cas "j ai ameliore et le score baisse" — l ecart V_n
// vs V_(n-1) reste lisible mais on lisse les regressions courtes pour ne pas
// demoraliser l artiste qui itere.
//
// TODO : "sauf degradation prouvee par DSP" (cf. spec ticket 4.1). Quand on
// aura une detection DSP de regression (LUFS hors cible, clipping apparu,
// crest factor effondre, etc.), elle desactivera localement le plancher.
// Tant que ce n est pas branche, le plancher s applique inconditionnellement.
// ─────────────────────────────────────────────────────────────
function applyScoreFloor(fiche, previousFiche) {
  if (!fiche || !previousFiche) return fiche;

  const applied = {};

  // Plancher global — max -3 points.
  const prevG = typeof previousFiche.globalScore === 'number' ? previousFiche.globalScore : null;
  if (prevG != null && typeof fiche.globalScore === 'number') {
    const floor = Math.max(0, prevG - 3);
    if (fiche.globalScore < floor) {
      applied.global = { prev: prevG, raw: fiche.globalScore, floor };
      fiche.globalScore = floor;
    }
  }

  // Plancher par categorie — max -5 points sur la moyenne.
  const avgByCat = (f) => {
    const map = new Map();
    if (!Array.isArray(f.elements)) return map;
    for (const el of f.elements) {
      if (!Array.isArray(el.items)) continue;
      const scores = el.items
        .filter((it) => it && typeof it.score === 'number')
        .map((it) => it.score);
      if (!scores.length) continue;
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      map.set((el.cat || '').toString().toLowerCase().trim(), { avg, items: el.items });
    }
    return map;
  };

  const prevAvgs = avgByCat(previousFiche);
  const currAvgs = avgByCat(fiche);

  const cats = [];
  for (const [cat, curr] of currAvgs.entries()) {
    const prev = prevAvgs.get(cat);
    if (!prev) continue;
    const floor = Math.max(0, prev.avg - 5);
    if (curr.avg < floor) {
      const lift = floor - curr.avg;
      for (const it of curr.items) {
        if (it && typeof it.score === 'number') {
          it.score = Math.max(0, Math.min(100, Math.round(it.score + lift)));
        }
      }
      cats.push({
        cat,
        prevAvg: Math.round(prev.avg),
        rawAvg: Math.round(curr.avg),
        floorAvg: Math.round(floor),
      });
    }
  }
  if (cats.length) applied.categories = cats;

  if (Object.keys(applied).length) fiche._floor_applied = applied;
  return fiche;
}

// ─────────────────────────────────────────────────────────────
// Advice-followed locking (ticket 4.2).
//
// S appuie sur la checklist (ticket 2.1) : `previousCompletions` est un
// tableau d ids d items qui ont ete coches "implementes" sur V_(n-1).
// Pour chaque categorie de V_(n-1) qui contient au moins un item coche,
// la moyenne de la categorie en V_n ne peut PAS etre inferieure a la
// moyenne en V_(n-1). Si la moyenne courante est en dessous, on releve
// uniformement les item.score de la categorie pour la ramener au niveau
// V_(n-1) (meme mecanique que applyScoreFloor mais plancher = prevAvg).
//
// Concretement : "j ai dit que je l avais implementee, donc c est au moins
// aussi bien qu avant". Le score peut MONTER librement, il ne peut pas
// regresser sur une zone ou l artiste a confirme une action.
//
// A appliquer APRES applyScoreFloor (le lock est plus strict que le floor
// pour les categories concernees, donc l ordre n a pas d effet sur le
// resultat final ; mais ca evite de calculer deux fois la meme correction).
// ─────────────────────────────────────────────────────────────
function applyAdviceLock(fiche, previousFiche, previousCompletions) {
  if (!fiche || !previousFiche) return fiche;
  if (!Array.isArray(previousCompletions) || !previousCompletions.length) return fiche;

  const completedSet = new Set(previousCompletions);

  // Categories de V_(n-1) qui contiennent au moins un item coche, avec leur moyenne.
  const lockedCats = new Map(); // catKey -> prevAvg
  if (Array.isArray(previousFiche.elements)) {
    for (const el of previousFiche.elements) {
      if (!Array.isArray(el.items)) continue;
      const hasCompleted = el.items.some((it) => it && it.id && completedSet.has(it.id));
      if (!hasCompleted) continue;
      const scores = el.items
        .filter((it) => it && typeof it.score === 'number')
        .map((it) => it.score);
      if (!scores.length) continue;
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      lockedCats.set((el.cat || '').toString().toLowerCase().trim(), avg);
    }
  }
  if (!lockedCats.size) return fiche;

  const cats = [];
  if (Array.isArray(fiche.elements)) {
    for (const el of fiche.elements) {
      if (!Array.isArray(el.items)) continue;
      const key = (el.cat || '').toString().toLowerCase().trim();
      const lockFloor = lockedCats.get(key);
      if (typeof lockFloor !== 'number') continue;
      const scores = el.items
        .filter((it) => it && typeof it.score === 'number')
        .map((it) => it.score);
      if (!scores.length) continue;
      const currAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (currAvg < lockFloor) {
        const lift = lockFloor - currAvg;
        for (const it of el.items) {
          if (it && typeof it.score === 'number') {
            it.score = Math.max(0, Math.min(100, Math.round(it.score + lift)));
          }
        }
        cats.push({
          cat: el.cat,
          prevAvg: Math.round(lockFloor),
          rawAvg: Math.round(currAvg),
        });
      }
    }
  }
  if (cats.length) {
    fiche._advice_lock_applied = { categories: cats, completedCount: completedSet.size };
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
- PAS de simulation relationnelle ("je sens que tu voulais", "j adore ce que tu fais"). Plus largement, JAMAIS de verbe d emotion/sensation a la 1re personne ("j ai pris plaisir", "j ai ete touche", "j ai aime", "ca me plait", "j ai kiffe") — tu observes, tu ne ressens rien. JAMAIS de tape sur l epaule ni de bilan encourageant ("tu t en sors", "avec les honneurs", "c est maitrise dans l ensemble", "bravo pour"). Reconnaitre qu un titre est un classique/standard reste OK, les adjectifs sur l interpretation aussi ("sensible", "portee", "habitee"), tant qu ils restent ancres. Reste factuel.
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
async function generateFiche(mode, daw, title, artist, listening, pmContext, previousFiche, intent, previousCompletions) {
  const isRef = mode === 'ref';
  const listeningStr = listening ? JSON.stringify(listening, null, 2) : 'AUCUNE ECOUTE DISPONIBLE (Gemini a echoue).';
  const hasPM = typeof pmContext === 'string' && pmContext.trim().length > 0;
  const hasIntent = typeof intent === 'string' && intent.trim().length > 0;
  const intentStr = hasIntent ? intent.trim() : '';

  const persoTemplate = JSON.stringify({
    elements: [
      { cat: "VOIX",                icon: "voice",   items: [{ id: "voice-1", section: "VOIX", priority: "high", title: "...", score: 72, why: "...", how: "...", plugin_pick: "..." }] },
      { cat: "INSTRUMENTS",         icon: "synths",  items: [] },
      { cat: "BASSES & KICK",       icon: "bass",    items: [] },
      { cat: "DRUMS & PERCUSSIONS", icon: "drums",   items: [] },
      { cat: "SPATIAL & REVERB",    icon: "fx",      items: [] },
      { cat: "MASTER & LOUDNESS",   icon: "lufs",    items: [] },
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
- Ce qui ressemble a un defaut mais s inscrit dans l intention est un CHOIX ASSUME, pas une erreur. Ne propose pas de le "corriger", sauf si tu penses que le choix dessert l intention elle-meme (et dans ce cas, explique le conflit dans le "why" de l item).
- Ce qui s ecarte de l intention sans raison apparente merite un item d ajustement, avec score bas si c est bien un defaut technique.
- Les references citees (artistes, albums) sont des boussoles : compare, ne copie pas.
- Les scores restent ancres sur les problematiques techniques (balance, dynamique, masquage, artefacts). Un choix revendique par l intention ne doit PAS tirer un score vers le bas.
- Le summary doit brievement reconnaitre l intention et dire si elle est globalement respectee ou si des ecarts notables sont reperes.
` : '';

  const systemPrompt = `Tu es ingenieur du son expert. Tu recois:
1. Une ECOUTE qualitative du morceau (JSON) faite par un collegue qui l a vraiment ecoute. C est ta source primaire sur CE morceau.
${hasPM ? '2. Des EXTRAITS DE COURS PUREMIX (transcripts d ingenieurs de mix reels) pertinents pour les problematiques evoquees par l ecoute. Tu peux t en inspirer pour ta pensee et ton vocabulaire, mais ne les cite jamais verbatim et ne les attribue pas nominativement.' : ''}${intentBlock}

Ton role: transformer tout ca en fiche structuree pour ${daw}${isRef ? ', ET un set de conseils de reproduction' : ''}.

REGLES DE FER:
- L ECOUTE est la SOURCE DE VERITE sur ce morceau. Tu n as AUCUNE MESURE DU MORCEAU (pas de BPM mesure, pas de LUFS mesure, pas de tonalite). N INVENTE jamais de valeur mesuree sur CE morceau-ci ("le kick est a 62 Hz", "la voix tape -8 LUFS", "BPM 124" : INTERDIT). En revanche, dans le champ "how" de chaque item tu PEUX et tu DOIS donner des VALEURS DE RECETTE GENERIQUES (Hz, dB, Q, ratio, attack/release en ms, GR en dB) qui correspondent a la technique pro typique pour ce type de probleme — ces valeurs sont des recettes connues, pas des mesures du titre.
- NE CONTREDIS PAS l ecoute. Si l ecoute ne parle pas de voix, n invente pas d item voix. Si l ecoute dit "mix instrumental", la categorie VOIX reste vide (items: []).
- N AJOUTE un item QUE si l ecoute a observe quelque chose de concret dans cette zone. Pas de remplissage generique.
- La categorie VOIX inclut aussi bien les leads que les choeurs/backing vocals. Precise de quelle voix tu parles quand c est utile.
- Une categorie d elements peut etre VIDE (items: []). C est acceptable et souvent correct.
${hasPM ? '- Les extraits PureMix t enrichissent la REFLEXION, pas le contenu. Reformule avec tes propres mots. Ne copie pas de phrases. Ne cite pas "PureMix" ni le nom d un ingenieur. Utilise-les pour mieux formuler les techniques, les priorites de mix, les reflexes pros.' : ''}
- Chaque item.why doit s appuyer sur une observation de l ecoute.
${isRef ? '- tips = 3-5 conseils concrets pour reproduire ce son dans ' + daw : '- items = UNIQUEMENT les vrais points identifies par l ecoute. Si l ecoute dit que le mix est deja pret, garde peu d items (1-2) ou seulement des ajustements de master. Ne fabrique pas d item pour remplir.\n- Le "how" et le "plugin_pick" de chaque item doivent porter la recommandation actionnable (recette technique chiffree + plugin precis). Il n y a plus de section "Plan d action" separee : tout passe par les items du diagnostic.'}
- "plugin_pick" doit nommer UN plugin reel adapte au DAW de l utilisateur (${daw}) : soit un plugin stock du DAW (ex: Channel EQ / Compressor / Space Designer dans Logic, Pro EQ / Compressor dans Studio One, ReaEQ / ReaComp dans Reaper, Parametric EQ 2 / Fruity Limiter dans FL Studio, Pro-Q / Pro-C dans Cubase), soit un standard industrie reel (FabFilter Pro-Q 3, FabFilter Pro-C 2, UAD LA-2A, UAD 1176, Waves SSL E-Channel, Waves SSL Bus Compressor, Soothe2, Valhalla VintageVerb, Oeksound Soothe2, etc.). UN seul plugin par item, nom EXACT. N INVENTE PAS de plugin qui n existe pas.
${!isRef ? '- SCHEMA STRICT POUR CHAQUE ITEM de elements[].items — exactement ces champs, pas d autres, pas d objet imbrique : "id" (string format <icon>-<N>), "section" (string egale a la valeur du champ "cat" de la categorie parente : VOIX / INSTRUMENTS / BASSES & KICK / DRUMS & PERCUSSIONS / SPATIAL & REVERB / MASTER & LOUDNESS), "priority" ("high" | "med" | "low", MINUSCULES uniquement), "title" (titre court 4-8 mots), "score" (entier 0-100), "why" (1-2 phrases ancrees sur l ecoute, sans valeurs mesurees du morceau), "how" (string courte avec recette technique CHIFFREE — exemples : "EQ soustractif 200-400 Hz, -3 dB, Q 1.5" / "compression voix 2:1, attack 10-20 ms, release 80-120 ms, 2-4 dB GR" / "de-esser 6-8 kHz, -4 dB GR" / "reverb plate decay 1.8 s, pre-delay 30 ms, mix 12%"), "plugin_pick" (UN plugin reel, voir regle plugin_pick).' : ''}
- summary = 1-2 phrases reprenant le verdict de l ecoute avec les priorites concretes. Meme ton direct et pro que l ecoute. INTERDIT de simuler une relation humaine: pas de "merci", "content de t entendre", "j adore", ni aucune marque d emotion personnelle. Plus largement, JAMAIS de verbe d emotion/sensation a la 1re personne ("j ai pris plaisir", "j ai ete touche", "j ai aime", "ca me plait", "j ai kiffe") — l IA observe, elle ne ressent rien. JAMAIS de tape sur l epaule ni de bilan encourageant ("tu t en sors", "avec les honneurs", "c est maitrise dans l ensemble", "bravo pour", "chapeau"). Reconnaitre qu un titre est un classique/standard reste autorise, et les adjectifs sur l interpretation aussi ("sensible", "portee", "habitee"), tant qu ils restent ancres dans une observation. Reste un collegue ingenieur qui brief, pas un ami qui fait des compliments.

REGLE IDS (obligatoire):
- Chaque item de elements[].items DOIT avoir un champ "id" unique au format "<icon>-<N>", ou <icon> est la valeur du champ "icon" de la categorie parente et <N> un entier qui commence a 1 et s incremente PAR categorie. Exemples: "voice-1", "voice-2", "bass-1", "drums-1", "lufs-1".

${!isRef ? `REGLE SCORES (obligatoire en mode diagnostic):
- Chaque item de elements[].items DOIT avoir un champ "score" (entier de 0 a 100) qui evalue l etat actuel de cet aspect du mix.
- Bareme calibre (ni trop severe, ni trop complaisant):
  - 0-30 : probleme majeur qui empeche le titre de fonctionner (voix inaudible, basse qui masque tout, master destructif).
  - 40-50 : defaut audible clair, a traiter pour passer a l etape suivante.
  - 60-70 : correct, pro mais pas encore convaincant, dernieres finitions.
  - 80-90 : tres bon niveau, commercialement defendable.
  - 100 : reference absolue. RARE. Seulement si l ecoute est dithyrambique.
- Ancre les scores STRICTEMENT sur ce que dit l ecoute. Un item existe parce que l ecoute a observe quelque chose : son score reflete ce verdict.
- Evite les scores tous identiques. Si l ecoute distingue forces et faiblesses, les scores doivent le refleter.

REGLE CRITIQUE — CHOIX ARTISTIQUES vs DEFAUTS TECHNIQUES:
- Distingue TOUJOURS les defauts techniques objectifs (saturation non voulue, desequilibre frequentiel, masquage, artefacts) des choix artistiques potentiellement voulus (fin abrupte, arrangement minimal, distorsion creative, structure non conventionnelle, absence d intro/outro, repetition voulue).
- Un choix artistique ne doit JAMAIS etre penalise dans le score comme un defaut. Si l ecoute releve quelque chose qui POURRAIT etre un choix delibere (fin abrupte, arrangement atypique, mix lo-fi, etc.), tu peux le mentionner comme suggestion/alternative dans le "why", mais le score doit rester neutre ou positif (70+). Formule-le comme "Si c est voulu, c est un parti pris defendable. Sinon, on pourrait envisager..." et non comme une erreur a corriger.
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

Produis le JSON de fiche en suivant exactement cette structure (conserve les "cat" et "icon", varie uniquement le contenu des items${!isRef ? ', les scores et le globalScore' : ''}):

${isRef ? refTemplate : persoTemplate}

Rappel: categories vides autorisees (items: []). ${isRef ? '' : 'Diagnostic minimaliste autorise si l ecoute est positive. Scores ancres dans le verdict de l ecoute.'} Reprends le ton et le verdict de l ecoute dans le summary.${hasPM ? ' Inspire-toi des extraits PureMix pour affiner la formulation, sans jamais les citer.' : ''}${hasIntent ? ' Tiens compte de l intention declaree : les choix qui en decoulent ne sont pas des defauts.' : ''}`;

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

  // On expose l intention utilisee dans la fiche pour que le front puisse
  // l afficher tel quel (badge "Intention declaree : ...") sans avoir a re-requeter.
  if (hasIntent) parsed.intent_used = intentStr;

  // Garde-fou ids/scores/globalScore, puis plancher de score
  // (ticket 4.1) et verrou des sub-scores avec items coches (ticket 4.2).
  let normalized = applyScoreFloor(normalizeIds(parsed), previousFiche);
  normalized = applyAdviceLock(normalized, previousFiche, previousCompletions);
  return normalized;
}

// ─────────────────────────────────────────────────────────────
// generateEvolution — suivi inter-versions.
// Recoit l ecoute + fiche d une version precedente (prev) et
// celles de la nouvelle version (curr), et produit un objet
// structure des evolutions destine au "bandeau evolution"
// affiche au-dessus de la fiche.
//
// Output JSON :
//   {
//     "resume":      "string (1 phrase, ~90 chars max)",
//     "progres":     ["string court", ...],   // 0-4
//     "regressions": ["string court", ...],   // 0-4
//     "persistants": ["string court", ...],   // 0-4
//     "nouveaux":    ["string court", ...],   // 0-4 — points apparus en V2
//     "dominante":   "progres" | "regressions" | "neutre"
//   }
//
// IMPORTANT : si l ecoute V1 ou V2 est vide, on renvoie un objet
// neutre plutot que de halluciner — la comparaison n a pas de
// fondement.
// ─────────────────────────────────────────────────────────────
async function generateEvolution(prev, curr, intent, locale) {
  const isFr = (locale || 'fr').toLowerCase().startsWith('fr');
  // Garde-fous : si l ecoute manque d un cote, pas d evolution exploitable.
  if (!prev || !curr || !prev.listening || !curr.listening) {
    return null;
  }

  const hasIntent = typeof intent === 'string' && intent.trim().length > 0;
  const intentStr = hasIntent ? intent.trim() : '';

  // Compaction des fiches : on ne garde que ce qui sert a la comparaison
  // (title, score, why) pour limiter la taille du prompt.
  const compactFiche = (f) => {
    if (!f || !Array.isArray(f.elements)) return null;
    return {
      globalScore: typeof f.globalScore === 'number' ? f.globalScore : null,
      summary: typeof f.summary === 'string' ? f.summary : '',
      elements: f.elements.map((el) => ({
        cat: el.cat,
        items: (el.items || []).map((it) => ({
          title: it.title,
          score: typeof it.score === 'number' ? it.score : null,
          why: typeof it.why === 'string' ? it.why.slice(0, 240) : '',
        })),
      })),
    };
  };

  const prevPack = {
    listening: prev.listening,
    fiche: compactFiche(prev.fiche),
  };
  const currPack = {
    listening: curr.listening,
    fiche: compactFiche(curr.fiche),
  };

  const intentBlock = hasIntent ? `

INTENTION ARTISTIQUE DECLAREE PAR L ARTISTE (vaut pour les deux versions sauf mention contraire):
"${intentStr}"

Une evolution qui rapproche de cette intention est un PROGRES, meme si elle peut sembler etre un defaut hors contexte. Une evolution qui s en eloigne est une REGRESSION.
` : '';

  const systemPrompt = `Tu es ingenieur du son. Tu recois DEUX ECOUTES qualitatives du MEME morceau a deux moments differents (V_PRECEDENTE puis V_NOUVELLE) ainsi que les diagnostics correspondants. Ta tache : produire un SUIVI court et factuel des evolutions entre les deux versions, destine a etre affiche dans un bandeau discret au-dessus de la fiche de la nouvelle version.${intentBlock}

REGLES DE FER :
- Tu ne mesures rien (pas de LUFS, pas de BPM, pas de Hz). Tu compares ce que les deux ecoutes decrivent et ce que les scores reflètent.
- N invente RIEN. Si une zone n est pas evoquee dans les deux ecoutes, tu n en parles pas.
- Si l evolution est nulle ou minime, les listes peuvent etre vides. NE FABRIQUE pas de progres pour remplir.
- Items courts : une phrase, ~70 caracteres max, ${isFr ? 'francais' : 'anglais'} naturel et direct, pas de jargon obscur.
- Resume : UNE phrase ~90 caracteres max qui synthetise la dominante (ex : ${isFr ? '"Voix plus claire mais basse en retrait, moins d air dans le haut."' : '"Voice clearer but bass pulled back, less air up top."'}).
- Distingue : progres (mieux qu avant), regressions (moins bien qu avant), persistants (point deja note en V_PRECEDENTE et toujours present), nouveaux (apparu en V_NOUVELLE et absent de V_PRECEDENTE).
- "dominante" : "progres" si plus de progres que de regressions, "regressions" si l inverse, "neutre" sinon.
- INTERDIT : ton relationnel ("bravo", "tu as bien progresse", "j adore", "j ai aime", "j ai pris plaisir"), tape sur l epaule, simulation d emotion. Tu es un collegue ingenieur qui brief, factuel.
- INTERDIT : le mot "chantier" — prefere "ajustement", "axe", "levier".
- INTERDIT : citer une marque de plugin ou un artiste/album hors de ce que dit l ecoute.
- Si V_PRECEDENTE et V_NOUVELLE racontent en realite deux morceaux differents (longueurs/ambiances tres ecartees), renvoie un resume neutre du type ${isFr ? '"Comparaison limitee : les deux versions semblent traiter deux passages differents."' : '"Comparison limited: the two versions seem to cover different passages."'} et des listes vides.

Reponds UNIQUEMENT en JSON valide ${isFr ? 'en francais' : 'en anglais'}, sans markdown, sans backticks :
{
  "resume": "string",
  "progres": ["string", ...],
  "regressions": ["string", ...],
  "persistants": ["string", ...],
  "nouveaux": ["string", ...],
  "dominante": "progres" | "regressions" | "neutre"
}`;

  const prompt = `V_PRECEDENTE :
${JSON.stringify(prevPack, null, 2)}

V_NOUVELLE :
${JSON.stringify(currPack, null, 2)}

Produis le JSON de suivi en suivant exactement le schema ci-dessus. Pas de markdown.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
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
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeout);
    if (fetchErr.name === 'AbortError') throw new Error('Evolution API: timeout (60s)');
    throw fetchErr;
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[evolution] API error:', res.status, body.slice(0, 300));
    throw new Error('Evolution API: ' + res.status);
  }

  const data = await res.json();
  let text = (data.content[0].text || '').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[evolution] no JSON in response');
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    console.error('[evolution] parse error:', e.message);
    return null;
  }

  // Normalisation defensive : on garantit la forme et les bornes (max 4 items
  // par liste, strings non vides) pour proteger l UI.
  const cleanList = (arr) =>
    Array.isArray(arr)
      ? arr.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()).slice(0, 4)
      : [];
  const dom = ['progres', 'regressions', 'neutre'].includes(parsed.dominante) ? parsed.dominante : 'neutre';

  return {
    resume: typeof parsed.resume === 'string' ? parsed.resume.trim().slice(0, 200) : '',
    progres: cleanList(parsed.progres),
    regressions: cleanList(parsed.regressions),
    persistants: cleanList(parsed.persistants),
    nouveaux: cleanList(parsed.nouveaux),
    dominante: dom,
  };
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

module.exports = { generateFiche, chat, formulatePerception, generateEvolution };
