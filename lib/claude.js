const fetch = require('node-fetch');
const MODEL = 'claude-sonnet-4-6';

async function generateFiche(fadrData, mode, daw, title, artist, listening) {
  const isRef = mode === 'ref';

  const measuredParts = [];
  if (fadrData) {
    if (fadrData.bpm) measuredParts.push(`BPM: ${fadrData.bpm}`);
    if (fadrData.key) measuredParts.push(`Tonalite: ${fadrData.key}`);
    if (fadrData.lufs) measuredParts.push(`LUFS: ${fadrData.lufs}`);
    if (fadrData.duration) measuredParts.push(`Duree: ${fadrData.duration}s`);
    if (fadrData.stems?.length) {
      measuredParts.push(`Stems: ${fadrData.stems.map(s => s.name || s.type || s.label).join(', ')}`);
    }
    if (fadrData.chords?.length) {
      measuredParts.push(`Accords: ${fadrData.chords.slice(0, 8).join(', ')}`);
    }
  }
  const measuredStr = measuredParts.length ? measuredParts.join('. ') : 'aucune mesure disponible';
  const listeningStr = listening ? JSON.stringify(listening, null, 2) : 'AUCUNE ECOUTE DISPONIBLE (Gemini a echoue).';

  const persoTemplate = JSON.stringify({
    elements: [
      { cat: "VOIX", icon: "voice", items: [{ conf: "identified", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "INSTRUMENTS", icon: "synths", items: [] },
      { cat: "BASSES & KICK", icon: "bass", items: [] },
      { cat: "DRUMS & PERCUSSIONS", icon: "drums", items: [] },
      { cat: "SPATIAL & REVERB", icon: "fx", items: [] },
      { cat: "MASTER & LOUDNESS", icon: "lufs", items: [] },
    ],
    plan: [],
    summary: "..."
  });

  const refTemplate = JSON.stringify({
    elements: [
      { cat: "VOIX", icon: "voice", items: [] },
      { cat: "INSTRUMENTS", icon: "synths", items: [] },
      { cat: "BASSES & KICK", icon: "bass", items: [] },
      { cat: "DRUMS & PERCUSSIONS", icon: "drums", items: [] },
      { cat: "SPATIAL & REVERB", icon: "fx", items: [] },
      { cat: "MASTER & LOUDNESS", icon: "lufs", items: [] },
    ],
    tips: [],
    summary: "..."
  });

  const systemPrompt = `Tu es ingenieur du son expert. Tu recois:
1. Une ECOUTE qualitative du morceau faite par un collegue qui l a ecoute (JSON).
2. Des MESURES techniques automatiques (Fadr).

Ton role: transformer cette matiere en fiche structuree pour ${daw}, ET ${isRef ? 'un set de conseils de reproduction' : 'un plan d actions concretes'}.

REGLES DE FER:
- NE CONTREDIS PAS l ecoute. Si l ecoute ne parle pas de voix, n invente pas d item voix. Si l ecoute dit "mix instrumental", la categorie VOIX reste vide (items: []).
- N AJOUTE un item QUE si l ecoute a observe quelque chose de concret dans cette zone OU si une mesure Fadr le justifie. Pas de remplissage generique base sur BPM ou tonalite.
- Une categorie d elements peut etre VIDE (items: []). C est acceptable et souvent correct.
- Chaque item.detail doit s appuyer sur une observation de l ecoute ou une mesure.
- ${isRef ? 'tips = 3-5 conseils concrets pour reproduire ce son dans ' + daw : 'plan = UNIQUEMENT les vrais chantiers identifies. Si l ecoute dit que le mix est deja pret, le plan peut etre tres court (1-2 items) ou ne contenir que des ajustements de master. Ne fabrique pas de chantier pour remplir.'}
- "tools" doit contenir des techniques (ex: "Sidechain basse-kick", "EQ soustractif 200-400Hz", "Compression parallele"), pas des noms de plugins.
- ${!isRef ? 'Pour plan: "metered" = valeur actuelle mesuree/observee si disponible (sinon laisse "") ; "target" = valeur cible recommandee ; "task" = titre court + "daw" = instruction concrete pour ' + daw + ' en une phrase conversationnelle (pas de liste sterile de parametres). Priorite "p" = HIGH / MED / LOW selon ce que l ecoute considere comme critique.' : ''}
- summary = 1-2 phrases reprenant le verdict de l ecoute avec les priorites concretes. Meme ton humain que l ecoute.
- Reponds UNIQUEMENT en JSON valide. Pas de markdown, pas de backticks.`;

  const prompt = `ECOUTE QUALITATIVE (source primaire):
${listeningStr}

MESURES FADR:
${measuredStr}

MORCEAU: "${title}"${artist ? ' — ' + artist : ''}
DAW utilisateur: ${daw}
MODE: ${isRef ? 'reference a reproduire' : 'diagnostic de mix perso'}

Produis le JSON de fiche en suivant exactement cette structure (conserve les "cat" et "icon", varie uniquement le contenu des items et du plan):
${isRef ? refTemplate : persoTemplate}

Rappel: categories vides autorisees (items: []). ${isRef ? '' : 'Plan minimaliste autorise si l ecoute est positive.'} Reprends le ton et le verdict de l ecoute dans le summary.`;

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
  try { return JSON.parse(text); }
  catch (e) {
    console.error('[claude] parse error:', e.message, text.slice(0, 500));
    throw new Error('JSON invalide: ' + e.message);
  }
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

module.exports = { generateFiche, chat };
