const fetch = require('node-fetch');
const MODEL = 'claude-sonnet-4-6';

// Garde-fou post-parse : genere les ids manquants, normalise les scores /100,
// et calcule un globalScore /100 pondere si absent.
function normalizeIds(fiche) {
  if (!fiche || !Array.isArray(fiche.elements)) return fiche;
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
// generateFiche — signature etendue avec deux parametres OPTIONNELS
// en fin :
//   - intent : bloc d intention artistique (cadre le diagnostic)
//   - fadrMetrics : mesures objectives Fadr ({bpm, key, lufs, stems, …})
//     branchees en 1.1bis (DSP_PLAN). 1.2 : exploitees dans le prompt
//     en tant que MESURES OBJECTIVES — Claude peut/doit les citer dans
//     les "why", "summary", "how" quand c est pertinent. Si absentes
//     (Fadr KO/timeout), le pipeline retombe sur le comportement
//     historique "aucune mesure".
// Tous les appels existants (sans intent / sans fadrMetrics) continuent
// de marcher inchanges.
// ─────────────────────────────────────────────────────────────
async function generateFiche(mode, daw, title, artist, listening, pmContext, previousFiche, intent, previousCompletions, fadrMetrics) {
  const isRef = mode === 'ref';
  const listeningStr = listening ? JSON.stringify(listening, null, 2) : 'AUCUNE ECOUTE DISPONIBLE (Gemini a echoue).';
  const hasPM = typeof pmContext === 'string' && pmContext.trim().length > 0;
  const hasIntent = typeof intent === 'string' && intent.trim().length > 0;
  const intentStr = hasIntent ? intent.trim() : '';
  const m = fadrMetrics || {};
  const mBpm = (typeof m.bpm === 'number' || (typeof m.bpm === 'string' && m.bpm.trim())) ? m.bpm : null;
  const mKey = (typeof m.key === 'string' && m.key.trim()) ? m.key.trim() : null;
  const mLufs = (typeof m.lufs === 'number') ? m.lufs : (typeof m.lufs === 'string' && m.lufs.trim() ? parseFloat(m.lufs) : null);
  const mLra = (typeof m.lra === 'number') ? m.lra : null;
  const mTruePeak = (typeof m.truePeak === 'number') ? m.truePeak : null;
  const hasMetrics = !!(mBpm || mKey || mLufs != null || mLra != null || mTruePeak != null);
  if (hasMetrics) {
    console.log('[claude] metrics injected in prompt — bpm:', mBpm, 'key:', mKey, 'lufs:', mLufs, 'lra:', mLra, 'truePeak:', mTruePeak);
  }
  // Le hasStems / hasStereo loggers sont definis plus bas (apres le calcul
  // des verdicts par stem/stereo). Voir log apres le bloc dspBlock.

  // Verdict contextualise sur le LUFS (cible streaming) pour aider Claude
  // a calibrer son diagnostic master sans le laisser deriver.
  let lufsVerdict = '';
  if (mLufs != null) {
    if (mLufs < -16) lufsVerdict = 'sous la cible streaming (vise -10 a -14 LUFS pour Spotify/Apple/YouTube), le master manque de presence';
    else if (mLufs < -10) lufsVerdict = 'dans la zone confortable streaming (Spotify/Apple normalisent autour de -14, donc tu as encore un peu de marge dynamique)';
    else if (mLufs < -7) lufsVerdict = 'dans le sweet spot streaming actuel (-10 a -8 LUFS), bon equilibre dynamique/loudness';
    else lufsVerdict = 'tres pousse (> -7 LUFS) : Spotify/Apple vont normaliser a la baisse, attention aux distorsions limiter';
  }

  // Verdict contextualise sur LRA (plage dynamique) :
  // - LRA < 4 : ecrasee, peu d air entre couplets/refrains (mastering tres tasse)
  // - 4-7   : moderne pop/electro, dynamique compressee mais ok
  // - 7-12  : confortable, respiration entre sections
  // - > 12  : large, classique/jazz/cinematic
  let lraVerdict = '';
  if (mLra != null) {
    if (mLra < 4) lraVerdict = 'plage dynamique tres ecrasee (limiteur tres present, peu d air entre les sections)';
    else if (mLra < 7) lraVerdict = 'plage dynamique pop/electro standard (compression maitrisee)';
    else if (mLra < 12) lraVerdict = 'plage dynamique confortable, sections respirent';
    else lraVerdict = 'plage dynamique large (classique/jazz/cinematic)';
  }

  // Verdict True Peak (clipping inter-sample) :
  // - > 0 dBTP : clipping garanti sur n importe quel encodeur lossy (mp3/aac)
  // - -1 a 0   : risque de clipping intersample apres encodage streaming
  // - <= -1    : safe streaming (cible standard -1 dBTP)
  let truePeakVerdict = '';
  if (mTruePeak != null) {
    if (mTruePeak > 0) truePeakVerdict = 'clipping intersample certain sur les encodeurs lossy (mp3/aac/opus). Critique a corriger : limiter -1 dBTP en sortie';
    else if (mTruePeak > -1) truePeakVerdict = 'risque de clipping intersample apres encodage streaming (cible standard : -1 dBTP). A descendre legerement';
    else truePeakVerdict = 'sous la cible -1 dBTP, safe pour les encodeurs streaming';
  }

  // ── DSP_PLAN B.5 — bloc STEMS (Phase 3) ───────────────────────────────
  // Mesures par stem isolé. Calcule un verdict "voix posée" (delta LUFS
  // voix vs instru), un proxy sibilantes (énergie 5-8 kHz du stem voix),
  // un proxy présence (énergie 1-3 kHz). Sur les autres stems, on expose
  // juste les valeurs (Claude se sert de l'écoute Gemini pour le qualitatif).
  const stemsArr = Array.isArray(m.stemsMeasured) ? m.stemsMeasured : [];
  const findStem = (type) => stemsArr.find((s) => s && s.stemType === type) || null;
  const vocalStem = findStem('vocal');
  const drumsStem = findStem('drums');
  const bassStem = findStem('bass');
  const otherStem = findStem('other');
  // LUFS instru reconstitué = moyenne pondérée des stems non-voix dispos.
  // Pas parfait (somme énergétique vraie demanderait une mesure de L_total),
  // mais une moyenne donne un repère utile pour le delta voix/instru.
  const instruLufs = (() => {
    const xs = [drumsStem, bassStem, otherStem]
      .map((st) => (st && typeof st.lufs === 'number') ? st.lufs : null)
      .filter((v) => v != null);
    if (!xs.length) return null;
    // Conversion en linéaire pour moyenner correctement, puis retour en dB.
    const lin = xs.map((db) => Math.pow(10, db / 10));
    const avg = lin.reduce((a, b) => a + b, 0) / lin.length;
    return +(10 * Math.log10(avg)).toFixed(1);
  })();
  const vocalLufs = vocalStem?.lufs ?? null;
  const voiceVsInstruDelta = (vocalLufs != null && instruLufs != null)
    ? +(vocalLufs - instruLufs).toFixed(1)
    : null;
  let voicePlacementVerdict = '';
  if (voiceVsInstruDelta != null) {
    if (voiceVsInstruDelta < -3) voicePlacementVerdict = 'voix en retrait par rapport a l instru (' + voiceVsInstruDelta + ' LU) : a remonter de ' + Math.abs(voiceVsInstruDelta + 1).toFixed(1) + ' dB pour rejoindre la cible -1 a +1 LU';
    else if (voiceVsInstruDelta > 3) voicePlacementVerdict = 'voix tres en avant (' + voiceVsInstruDelta + ' LU au dessus de l instru) : peut sembler agressive ou detachee, a calibrer selon le genre';
    else voicePlacementVerdict = 'voix bien posee dans le mix (delta ' + voiceVsInstruDelta + ' LU vs instru, dans la cible -3/+3 LU)';
  }
  // Sibilantes : énergie de la voix dans 5-8 kHz. Repère perceptif :
  // > -25 dB = sibilantes proeminentes (susceptibles), -30 a -25 = présentes,
  // < -30 = douces. Echelle approximative car varie selon registre vocal.
  let sibilantsVerdict = '';
  const sibilantsBand = vocalStem?.energyBand_5_8kHz ?? null;
  if (sibilantsBand != null) {
    if (sibilantsBand > -25) sibilantsVerdict = 'sibilantes appuyees (energie 5-8 kHz a ' + sibilantsBand + ' dB), de-esser conseille (Sibilance ratio 4:1, threshold -28 dB)';
    else if (sibilantsBand > -30) sibilantsVerdict = 'sibilantes presentes mais maitrisees (' + sibilantsBand + ' dB sur 5-8 kHz)';
    else sibilantsVerdict = 'sibilantes douces (' + sibilantsBand + ' dB sur 5-8 kHz), pas d action urgente';
  }
  // Presence (1-3 kHz) : zone d intelligibilite des voyelles + transitoires
  // d articulation. Pas de verdict normatif (le bon niveau depend du genre)
  // mais on expose la valeur pour que Claude puisse comparer.
  const presenceBand = vocalStem?.energyBand_1_3kHz ?? null;

  const stemsLines = [];
  if (vocalStem) stemsLines.push(`- VOIX : ${vocalStem.lufs != null ? vocalStem.lufs + ' LUFS' : 'mesure KO'}${vocalStem.truePeak != null ? ' / ' + vocalStem.truePeak + ' dBTP' : ''}${sibilantsBand != null ? ' / 5-8 kHz: ' + sibilantsBand + ' dB' : ''}${presenceBand != null ? ' / 1-3 kHz: ' + presenceBand + ' dB' : ''}`);
  if (drumsStem) stemsLines.push(`- DRUMS : ${drumsStem.lufs != null ? drumsStem.lufs + ' LUFS' : 'mesure KO'}${drumsStem.truePeak != null ? ' / ' + drumsStem.truePeak + ' dBTP' : ''}`);
  if (bassStem) stemsLines.push(`- BASS : ${bassStem.lufs != null ? bassStem.lufs + ' LUFS' : 'mesure KO'}${bassStem.truePeak != null ? ' / ' + bassStem.truePeak + ' dBTP' : ''}`);
  if (otherStem) stemsLines.push(`- INSTRU (other) : ${otherStem.lufs != null ? otherStem.lufs + ' LUFS' : 'mesure KO'}${otherStem.truePeak != null ? ' / ' + otherStem.truePeak + ' dBTP' : ''}`);
  if (instruLufs != null) stemsLines.push(`- INSTRU GLOBAL (moyenne energetique) : ${instruLufs} LUFS`);
  if (voiceVsInstruDelta != null) stemsLines.push(`- DELTA VOIX/INSTRU : ${voiceVsInstruDelta > 0 ? '+' : ''}${voiceVsInstruDelta} LU — ${voicePlacementVerdict}`);
  if (sibilantsVerdict) stemsLines.push(`- SIBILANTES : ${sibilantsVerdict}`);
  const hasStems = stemsLines.length > 0;

  // ── DSP_PLAN B.5 — bloc STEREO (Phase 3) ──────────────────────────────
  // Corrélation L/R, Mid/Side ratio, balance L/R, mono compat. Permet a
  // Claude de proposer des recettes spatial/reverb calibrees.
  const stereo = m.stereo || null;
  const mCorr = stereo && typeof stereo.correlation === 'number' ? stereo.correlation : null;
  const mMS = stereo && typeof stereo.midSideRatio === 'number' ? stereo.midSideRatio : null;
  const mBal = stereo && typeof stereo.balanceLR === 'number' ? stereo.balanceLR : null;
  const mMonoCompat = stereo && typeof stereo.monoCompat === 'number' ? stereo.monoCompat : null;
  let corrVerdict = '';
  if (mCorr != null) {
    if (mCorr > 0.85) corrVerdict = 'mix etroit/quasi mono (corr > 0.85), peu de largeur stereo — possibilite d elargir avec un Haas court ou un mid/side EQ';
    else if (mCorr > 0.6) corrVerdict = 'image stereo equilibree (correlation moderee), bon compromis largeur/cohesion';
    else if (mCorr > 0.2) corrVerdict = 'mix tres large (correlation faible) : verifier la mono-compat ci-dessous avant validation';
    else corrVerdict = 'risque de problemes de phase (correlation < 0.2) : tester en mono, des elements peuvent disparaitre';
  }
  let monoCompatVerdict = '';
  if (mMonoCompat != null) {
    if (mMonoCompat <= 1) monoCompatVerdict = 'excellent en mono (perte ' + mMonoCompat + ' LU vs stereo)';
    else if (mMonoCompat <= 2) monoCompatVerdict = 'mono OK mais perte sensible (' + mMonoCompat + ' LU) : surement des elements mid/side qui s annulent partiellement';
    else monoCompatVerdict = 'mono dangereux (perte ' + mMonoCompat + ' LU) : des elements en side disparaissent ou s attenuent en lecture mono (telephone, enceinte BT)';
  }
  let balanceVerdict = '';
  if (mBal != null) {
    const absB = Math.abs(mBal);
    if (absB < 0.5) balanceVerdict = 'mix bien centre (balance L/R a ' + mBal + ' dB)';
    else if (absB < 1.5) balanceVerdict = 'leger desequilibre L/R (' + mBal + ' dB) — pencheche ' + (mBal > 0 ? 'a gauche' : 'a droite') + ', surement intentionnel';
    else balanceVerdict = 'desequilibre marque L/R (' + mBal + ' dB) : verifier que c est bien intentionnel sinon recentrer le bus master';
  }
  const stereoLines = [];
  if (mCorr != null) stereoLines.push(`- CORRELATION L/R : ${mCorr} — ${corrVerdict}`);
  if (mMS != null) stereoLines.push(`- MID/SIDE RATIO : ${mMS} (part d energie sur le side, ${(mMS * 100).toFixed(0)}%)`);
  if (mBal != null) stereoLines.push(`- BALANCE L/R : ${mBal > 0 ? '+' : ''}${mBal} dB — ${balanceVerdict}`);
  if (mMonoCompat != null) stereoLines.push(`- MONO COMPAT : ${mMonoCompat > 0 ? '+' : ''}${mMonoCompat} LU (LUFS_stereo - LUFS_mono) — ${monoCompatVerdict}`);
  const hasStereo = stereoLines.length > 0;

  // Bloc MESURES OBJECTIVES injecte au debut du systemPrompt.
  // Format pensé pour aider Claude :
  // - liste claire de ce qu il SAIT (pour pouvoir le citer textuellement)
  // - verdicts pre-calcules pour calibrer le diagnostic master/voix/stereo
  // - garde-fous pour ne pas inventer d autres mesures
  const hasAnyDspContent = hasMetrics || hasStems || hasStereo;
  if (hasStems) console.log('[claude] stems injected — count:', stemsArr.length, 'voix delta:', voiceVsInstruDelta, 'sibilants:', sibilantsBand);
  if (hasStereo) console.log('[claude] stereo injected — corr:', mCorr, 'M/S:', mMS, 'monoCompat:', mMonoCompat);
  const dspBlock = hasAnyDspContent ? `

MESURES OBJECTIVES DU MORCEAU (sources fiables, conformes aux standards) :
${mBpm ? `- BPM : ${mBpm} (Fadr)` : ''}
${mKey ? `- Tonalité : ${mKey} (Fadr — reformule en clair si pertinent : "Eb maj" -> "Mi bémol majeur", "Am" -> "La mineur").` : ''}
${mLufs != null ? `- Loudness intégré : ${mLufs} LUFS (mesuré via ffmpeg ebur128, ITU-R BS.1770) — ${lufsVerdict}.` : ''}
${mLra != null ? `- LRA (Loudness Range) : ${mLra} LU — ${lraVerdict}.` : ''}
${mTruePeak != null ? `- True Peak max : ${mTruePeak} dBTP — ${truePeakVerdict}.` : ''}
${hasStems ? `

MESURES PAR STEM (Fadr separation + ffmpeg ebur128 + bandpass — DSP_PLAN Phase 3) :
${stemsLines.join('\n')}` : ''}
${hasStereo ? `

MESURES CHAMP STEREO (ffmpeg astats sur le master — DSP_PLAN Phase 3) :
${stereoLines.join('\n')}` : ''}

EXPLOITATION DE CES MESURES :
- Tu PEUX et tu DOIS citer ces valeurs dans les champs "why", "summary" ou "how" quand elles eclairent un point. Cite les valeurs TEXTUELLEMENT (dis "${mBpm || 'X'} BPM" / "${mLufs ?? 'X'} LUFS" / "${mTruePeak ?? 'X'} dBTP", pas "un tempo modéré" ou "un loudness eleve").
- En MASTER & LOUDNESS, c est OBLIGATOIRE de t appuyer sur LUFS / LRA / True Peak quand ils sont disponibles. Si le LUFS est sous la cible streaming, propose de remonter (recette "how" : "monter de X dB pour atteindre -10 LUFS"). Si le True Peak est > -1 dBTP, propose un limiter ceiling a -1 dBTP. Si le LRA est tres bas, suggere d alleger la compression bus master.${hasStems ? `
- En VOIX, calibre tes items sur les mesures stems : delta voix/instru ${voiceVsInstruDelta != null ? '(' + voiceVsInstruDelta + ' LU' + (voiceVsInstruDelta < -3 ? ', voix en retrait — recette : remonter le bus voix de ' + Math.abs(voiceVsInstruDelta + 1).toFixed(1) + ' dB' : voiceVsInstruDelta > 3 ? ', voix proeminente' : ', cible OK') + ')' : ''}, sibilantes ${sibilantsBand != null ? '(' + sibilantsBand + ' dB sur 5-8 kHz' + (sibilantsBand > -25 ? ' — de-esser conseille' : '') + ')' : ''}. Si la voix est en retrait, propose une remontee precise basee sur la mesure et non un avis vague.` : ''}${hasStereo ? `
- En SPATIAL & REVERB ou MASTER, calibre sur la stereo : ${mCorr != null ? 'correlation ' + mCorr + (mCorr < 0.2 ? ' = risque de phase, tester en mono' : mCorr > 0.85 ? ' = mix etroit, possibilite d elargir' : '') : ''}${mMonoCompat != null ? ', mono compat ' + mMonoCompat + ' LU' + (mMonoCompat > 2 ? ' = des elements disparaissent en mono, a corriger via mid/side EQ ou repositionner les sources side critiques au centre' : '') : ''}.` : ''}
- En BASSES & KICK ou INSTRUMENTS, la tonalite t aide : si l'écoute parle de masquage basse-grave, tu peux preciser que la fondamentale ${mKey ? 'est en ' + mKey : ''} et donner des frequences EQ adaptees a cette tonalite.
- Le BPM peut justifier des recettes de delay/reverb time (ex: "delay 1/8 = ${mBpm ? Math.round(60000 / mBpm / 2) + ' ms' : '...'}", "reverb decay calé sur ${mBpm ? Math.round(60000 / mBpm * 2) + ' ms' : '...'} = 2 temps"). Tu peux faire ces calculs.

GARDE-FOUS :
- N invente JAMAIS d AUTRES mesures que celles listees ci-dessus. Pas de "le kick tape a 62 Hz", pas de "la voix est a -8 dBFS sur les pics", pas de "le crest factor est de 12 dB" : ces valeurs ne sont pas mesurees, donc INTERDITES en tant que mesures de CE titre.
- Tu peux donner des VALEURS DE RECETTE GENERIQUES dans "how" (Hz, dB, ratio, attack/release en ms, GR en dB) — ce sont des techniques pro standard, pas des mesures du titre.
` : '';

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
1. Une ECOUTE qualitative du morceau (JSON) faite par un collegue qui l a vraiment ecoute. C est ta source primaire sur le RESSENTI de CE morceau.
${hasPM ? '2. Des EXTRAITS DE COURS PUREMIX (transcripts d ingenieurs de mix reels) pertinents pour les problematiques evoquees par l ecoute. Tu peux t en inspirer pour ta pensee et ton vocabulaire, mais ne les cite jamais verbatim et ne les attribue pas nominativement.' : ''}${hasAnyDspContent ? `\n3. Des MESURES OBJECTIVES (BPM, tonalite, LUFS, LRA, True Peak${hasStems ? ', mesures par stem voix/drums/bass/other' : ''}${hasStereo ? ', champ stereo (correlation L/R, mid/side, mono compat)' : ''}) calculees sur le fichier audio par un module DSP fiable. Ce sont des verites factuelles a utiliser dans la fiche.` : ''}${intentBlock}${dspBlock}

Ton role: transformer tout ca en fiche structuree pour ${daw}${isRef ? ', ET un set de conseils de reproduction' : ''}.

REGLES DE FER:
- L ECOUTE est la SOURCE DE VERITE sur le RESSENTI de ce morceau (timbre, intelligibilite, dynamique percue, equilibre). ${hasMetrics ? 'Les MESURES OBJECTIVES listees plus haut (BPM, tonalite, LUFS) sont la source de verite sur les valeurs FACTUELLES du fichier audio — tu DOIS les citer telles quelles dans tes "why"/"summary"/"how" quand c est pertinent. En revanche, n invente AUCUNE autre mesure (pas de "le kick est a 62 Hz", pas de "la voix tape -8 dBFS sur les pics", pas de "crest factor 12 dB") : seules les valeurs explicitement listees plus haut sont mesurees.' : 'Tu n as AUCUNE MESURE DU MORCEAU (pas de BPM mesure, pas de LUFS mesure, pas de tonalite). N INVENTE jamais de valeur mesuree sur CE morceau-ci ("le kick est a 62 Hz", "la voix tape -8 LUFS", "BPM 124" : INTERDIT).'} En revanche, dans le champ "how" de chaque item tu PEUX et tu DOIS donner des VALEURS DE RECETTE GENERIQUES (Hz, dB, Q, ratio, attack/release en ms, GR en dB) qui correspondent a la technique pro typique pour ce type de probleme — ces valeurs sont des recettes connues, pas des mesures du titre.
- NE CONTREDIS PAS l ecoute. Si l ecoute dit "mix instrumental" / vocalBlock instrumental, la categorie VOIX reste vide (items: []).
- COUVERTURE PAR CATEGORIE — REGLE IMPORTANTE : l ecoute fournit un champ "par_categorie" qui couvre les 6 categories canoniques (voix, instruments, basses_kick, drums_percu, spatial_reverb, master_loudness). Pour CHAQUE categorie commentee dans "par_categorie", tu DOIS generer AU MOINS 1 item dans la categorie correspondante de la fiche :
  * Si l observation est globalement positive (rien a corriger) -> item de VALIDATION : score 80+, "title" formule en constat positif (ex: "Image stereo coherente", "Caisse claire bien tranchante"), "why" qui reprend l observation positive de l ecoute, "how" optionnel ou tres court (ex: "RAS, conserver tel quel — surveiller au mastering pour ne pas degrader cet equilibre"), "plugin_pick" peut etre un outil de monitoring/verification (ex: Logic Multimeter, FabFilter Pro-Q 4 en analyzer-only, SPAN gratuit) plutot qu un correctif.
  * Si l observation pointe un probleme -> item CORRECTIF classique : score sous 70, "why" descriptif, "how" avec recette chiffree, "plugin_pick" correctif.
  * Si l ecoute mentionne plusieurs choses dans la meme categorie (ex: 1 positif + 1 negatif), tu peux faire 2 items.
- Mapping des cles de "par_categorie" vers les categories canoniques de la fiche :
  * voix -> "VOIX" (icon: voice)
  * instruments -> "INSTRUMENTS" (icon: synths)
  * basses_kick -> "BASSES & KICK" (icon: bass)
  * drums_percu -> "DRUMS & PERCUSSIONS" (icon: drums)
  * spatial_reverb -> "SPATIAL & REVERB" (icon: fx)
  * master_loudness -> "MASTER & LOUDNESS" (icon: lufs)
- Une categorie d elements ne reste VIDE que si "par_categorie" ne dit rien la-dessus (cas typique : voix sur un titre instrumental). Sinon, items vide = item manquant pour l artiste.
- La categorie VOIX inclut aussi bien les leads que les choeurs/backing vocals. Precise de quelle voix tu parles quand c est utile.
${hasPM ? '- Les extraits PureMix t enrichissent la REFLEXION, pas le contenu. Reformule avec tes propres mots. Ne copie pas de phrases. Ne cite pas "PureMix" ni le nom d un ingenieur. Utilise-les pour mieux formuler les techniques, les priorites de mix, les reflexes pros.' : ''}
- Chaque item.why doit s appuyer sur une observation de l ecoute (idealement de "par_categorie").
${isRef ? '- tips = 3-5 conseils concrets pour reproduire ce son dans ' + daw : '- items = couverture des observations de "par_categorie" (1 item de validation OU 1 item correctif par categorie commentee). Tu peux ajouter 1 item supplementaire si "a_travailler" pointe quelque chose de plus precis qui ne tient pas dans le commentaire de "par_categorie".\n- Le "how" et le "plugin_pick" de chaque item doivent porter la recommandation actionnable (recette technique chiffree + plugin precis pour les correctifs ; outil de verification ou note "RAS conserver" pour les validations). Il n y a plus de section "Plan d action" separee : tout passe par les items du diagnostic.'}
- "plugin_pick" doit nommer UN plugin reel adapte au DAW de l utilisateur (${daw}) : soit un plugin stock du DAW (ex: Channel EQ / Compressor / Space Designer dans Logic, Pro EQ / Compressor dans Studio One, ReaEQ / ReaComp dans Reaper, Parametric EQ 2 / Fruity Limiter dans FL Studio, Pro-Q / Pro-C dans Cubase), soit un standard industrie reel (FabFilter Pro-Q 4, FabFilter Pro-C 2, UAD LA-2A, UAD 1176, Waves SSL E-Channel, Waves SSL Bus Compressor, Soothe2, Valhalla VintageVerb, Oeksound Soothe2, etc.). UN seul plugin par item, nom EXACT. N INVENTE PAS de plugin qui n existe pas.
${!isRef ? `- SCHEMA STRICT POUR CHAQUE ITEM de elements[].items — exactement ces champs, pas d autres, pas d objet imbrique : "id" (string format <icon>-<N>), "section" (string egale a la valeur du champ "cat" de la categorie parente : VOIX / INSTRUMENTS / BASSES & KICK / DRUMS & PERCUSSIONS / SPATIAL & REVERB / MASTER & LOUDNESS), "priority" ("high" | "med" | "low", MINUSCULES uniquement), "title" (titre court 4-8 mots), "score" (entier 0-100), "why" (1-2 phrases ancrees sur l ecoute${hasMetrics ? ', avec citation possible des MESURES OBJECTIVES listees plus haut (BPM, tonalite, LUFS) quand elles eclairent le point' : ', sans valeurs mesurees du morceau'}), "how" (string courte avec recette technique CHIFFREE — exemples : "EQ soustractif 200-400 Hz, -3 dB, Q 1.5" / "compression voix 2:1, attack 10-20 ms, release 80-120 ms, 2-4 dB GR" / "de-esser 6-8 kHz, -4 dB GR" / "reverb plate decay 1.8 s, pre-delay 30 ms, mix 12%"), "plugin_pick" (UN plugin reel, voir regle plugin_pick).` : ''}
- summary = COURT (2-3 phrases max, ~40-60 mots). C est un coup d œil, pas une lecture : identite du titre + 1-2 priorites majeures uniquement. Le reste passe par les items du diagnostic — pas de redite. Cible : un fan de musique qui n a JAMAIS touche un mixeur doit comprendre en 5 secondes ou est le titre.

- REGLES STRICTES POUR LE SUMMARY (zero tolerance) :

  (1) AUCUN terme technique d ingenieur son, jamais. Liste noire non exhaustive : True Peak, TruePeak, dBTP, LUFS, LU, LRA, dB, dBFS, Hz, kHz, ceiling, headroom, RMS, crest factor, intersample, clipping, sibilantes, de-esser, de-essing, EQ, equaliseur, compresseur, compression, multibande, ratio, attaque, release, side-chain, mid/side, mono compat, mono compatibility, gain staging, masking, masquage frequentiel, transitoires, pumping, bus, mix bus, master bus, low-cut, high-pass, low-shelf, fondamentale, harmonique. Si le mot vient du jargon d un ingenieur son, il ne va PAS dans le summary.

  (2) AUCUNE recette, AUCUNE valeur cible, AUCUN nom d outil. Pas de "-1 dBTP", pas de "+3 dB", pas de "compresser a 2:1", pas de "limiter", pas de "EQ", pas de "saturator". Les recettes vivent dans items[].how, JAMAIS dans le summary. Le summary pointe le souci ("a reprendre avant diffusion", "a reverifier en mono telephone"), il ne dicte AUCUNE solution technique.

  (3) Tout est traduit en sensation d ecoute ou impact concret. Exemples de traduction obligatoires :
    * "voix bien posee, devant le mix" et NON "delta +2 LU" / "voix +2 LU au dessus de l instru"
    * "le titre frole la saturation, risque de craquer sur Spotify ou Apple Music — a reprendre avant diffusion" et NON "True Peak >0 dBTP, clipping intersample, ceiling a -1 dBTP"
    * "le titre est compresse serre, il gagnerait a respirer un peu plus" et NON "LRA 2.9 LU, dynamique ecrasee"
    * "perd de la presence quand on l ecoute sur telephone ou enceinte Bluetooth" et NON "perte mono 3.6 LU, mono compat degradee"
    * "guitare lead un peu trop brillante, fatigue l oreille sur la duree" et NON "exces 2-4 kHz, sibilantes a -25 dB"
    * "le lead synthe manque un peu de presence pour s imposer dans les sections denses" reste OK (vocabulaire mainstream, c est valide)

  (4) Test mental obligatoire : si tu retires les termes interdits (1) et les recettes (2) et qu il ne reste plus rien d intelligible, c est que tu n as pas traduit — recommence. Le summary doit fonctionner SANS aucun chiffre ni jargon.
- INTERDIT aussi de simuler une relation humaine: pas de "merci", "content de t entendre", "j adore", ni aucune marque d emotion personnelle. Plus largement, JAMAIS de verbe d emotion/sensation a la 1re personne ("j ai pris plaisir", "j ai ete touche", "j ai aime", "ca me plait", "j ai kiffe") — l IA observe, elle ne ressent rien. JAMAIS de tape sur l epaule ni de bilan encourageant ("tu t en sors", "avec les honneurs", "c est maitrise dans l ensemble", "bravo pour", "chapeau"). Reconnaitre qu un titre est un classique/standard reste autorise, et les adjectifs sur l interpretation aussi ("sensible", "portee", "habitee"), tant qu ils restent ancres dans une observation. Reste un collegue ingenieur qui brief, pas un ami qui fait des compliments.

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
INTENTION DECLAREE: "${intentStr}"` : ''}${hasAnyDspContent ? `
MESURES OBJECTIVES :${mBpm ? ` BPM=${mBpm}` : ''}${mKey ? ` · Tonalite=${mKey}` : ''}${mLufs != null ? ` · LUFS=${mLufs}` : ''}${mLra != null ? ` · LRA=${mLra} LU` : ''}${mTruePeak != null ? ` · TruePeak=${mTruePeak} dBTP` : ''}${voiceVsInstruDelta != null ? ` · Voix vs instru=${voiceVsInstruDelta > 0 ? '+' : ''}${voiceVsInstruDelta} LU` : ''}${sibilantsBand != null ? ` · Sibilantes(5-8k)=${sibilantsBand} dB` : ''}${mCorr != null ? ` · CorrL/R=${mCorr}` : ''}${mMonoCompat != null ? ` · MonoCompat=${mMonoCompat > 0 ? '+' : ''}${mMonoCompat} LU` : ''}
↳ Cite ces valeurs textuellement dans tes "why"/"how" quand elles eclairent un point. Le summary, lui, ne cite JAMAIS de valeur mesuree brute — il traduit l impact en sensation d ecoute. En MASTER, calibre sur LUFS/LRA/TruePeak.${hasStems ? ' En VOIX, calibre sur le delta voix/instru et les sibilantes mesurees.' : ''}${hasStereo ? ' En SPATIAL, calibre sur correlation L/R et mono compat.' : ''} N invente AUCUNE autre mesure.` : ''}

Produis le JSON de fiche en suivant exactement cette structure (conserve les "cat" et "icon", varie uniquement le contenu des items${!isRef ? ', les scores et le globalScore' : ''}):

${isRef ? refTemplate : persoTemplate}

Rappel: ${isRef ? 'categories vides autorisees uniquement si "par_categorie" est vide ou absent.' : 'genere AU MOINS 1 item par categorie commentee dans "par_categorie" (validation si rien a corriger, correctif sinon). Une categorie ne reste vide que si "par_categorie" n a rien dit dessus (typiquement: voix sur un titre instrumental). Scores ancres dans le verdict de l ecoute.'} Reprends le ton et le verdict de l ecoute dans le summary.${hasPM ? ' Inspire-toi des extraits PureMix pour affiner la formulation, sans jamais les citer.' : ''}${hasIntent ? ' Tiens compte de l intention declaree : les choix qui en decoulent ne sont pas des defauts.' : ''}`;

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

  // Pre-repair de glitches connus de generation JSON par Claude.
  // Cas observe en prod (jobId irii2vibzwmohdlyev) : "score">60 au lieu de "score":60.
  // On cible UNIQUEMENT le pattern "clef">nombre (ne touche pas aux strings, qui
  // contiendraient des lettres/espaces avant le >). Idem pour "clef"=valeur si jamais.
  const repairedText = text
    .replace(/("\w+")\s*>\s*(-?\d)/g, '$1:$2')
    .replace(/("\w+")\s*=\s*(-?\d)/g, '$1:$2');
  if (repairedText !== text) {
    console.warn('[claude] applied JSON glitch repair (operator-instead-of-colon)');
    text = repairedText;
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
