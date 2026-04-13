const fetch = require('node-fetch');
const MODEL = 'claude-sonnet-4-6';

async function generateFiche(fadrData, mode, daw, title, artist) {
  const isRef = mode === 'ref';

  // Build rich data string from Fadr analysis
  const parts = [];
  if (fadrData) {
    if (fadrData.bpm) parts.push(`BPM: ${fadrData.bpm}`);
    if (fadrData.key) parts.push(`Tonalite: ${fadrData.key}`);
    if (fadrData.lufs) parts.push(`LUFS: ${fadrData.lufs}`);
    if (fadrData.duration) parts.push(`Duree: ${fadrData.duration}s`);
    if (fadrData.stems?.length) {
      parts.push(`Stems detectes: ${fadrData.stems.map(s => s.name || s.type || s.label).join(', ')}`);
    }
    if (fadrData.chords?.length) {
      parts.push(`Accords: ${fadrData.chords.slice(0, 8).join(', ')}...`);
    }
  }
  const dataStr = parts.length ? parts.join('. ') : 'Aucune donnee audio disponible';

  const persoTemplate = JSON.stringify({
    elements: [
      { cat: "VOIX", icon: "voice", items: [{ conf: "identified", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "INSTRUMENTS", icon: "synths", items: [{ conf: "identified", label: "...", detail: "...", tools: ["..."] }, { conf: "identified", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "BASSES & KICK", icon: "bass", items: [{ conf: "identified", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "DRUMS & PERCUSSIONS", icon: "drums", items: [{ conf: "identified", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "SPATIAL & REVERB", icon: "fx", items: [{ conf: "suggested", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "MASTER & LOUDNESS", icon: "lufs", items: [{ conf: "measured", label: "...", detail: "...", tools: ["..."] }] },
    ],
    plan: [
      { p: "HIGH", task: "...", daw: "...", metered: "...", target: "..." },
      { p: "HIGH", task: "...", daw: "...", metered: "...", target: "..." },
      { p: "MED", task: "...", daw: "...", metered: "...", target: "..." },
      { p: "LOW", task: "...", daw: "...", metered: "...", target: "..." },
    ],
    summary: "..."
  });

  const refTemplate = JSON.stringify({
    elements: [
      { cat: "VOIX", icon: "voice", items: [{ conf: "identified", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "INSTRUMENTS", icon: "synths", items: [{ conf: "identified", label: "...", detail: "...", tools: ["..."] }, { conf: "identified", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "BASSES & KICK", icon: "bass", items: [{ conf: "identified", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "DRUMS & PERCUSSIONS", icon: "drums", items: [{ conf: "identified", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "SPATIAL & REVERB", icon: "fx", items: [{ conf: "suggested", label: "...", detail: "...", tools: ["..."] }] },
      { cat: "MASTER & LOUDNESS", icon: "lufs", items: [{ conf: "measured", label: "...", detail: "...", tools: ["..."] }] },
    ],
    tips: ["...", "...", "..."],
    summary: "..."
  });

  const systemPrompt = `Tu es un expert en production musicale et mixage avec 20 ans d'experience. Tu analyses des productions pour aider les artistes a progresser.

REGLES STRICTES:
- Reponds UNIQUEMENT avec un objet JSON valide
- Pas de markdown, pas de backticks, pas de commentaires
- Chaque "..." doit etre remplace par du contenu pertinent et concret
- Dans "tools", mets des techniques ou approches concretes (ex: "Compression parallele", "EQ soustractif 200-400Hz", "Sidechain kick-basse"), PAS des noms de plugins
- Parle des INSTRUMENTS presents dans le morceau : identifie les sons, les textures, les couches
- Pour les items, donne 2-4 items par categorie avec des observations specifiques au morceau
- Le "detail" doit etre une phrase precise et utile, pas du blabla generique
- Le "summary" est un verdict en 2 phrases max
- IMPORTANT: Tu n'entends PAS le morceau. Tu analyses uniquement les donnees techniques (stems, BPM, tonalite, LUFS). Ne devine JAMAIS le genre vocal (homme/femme), le style de chant, l'emotion ou le timbre de la voix. Concentre-toi sur le traitement technique de la voix (compression, EQ, reverb, placement dans le mix) et non sur des caracteristiques que tu ne peux pas connaitre.
${!isRef ? `- Dans "plan", chaque action doit etre ultra-concrete avec une instruction DAW precise pour ${daw}
- "metered" = la valeur actuelle mesuree ou estimee (ex: "-8 LUFS", "pic a +3dB a 250Hz", "correlation stereo 0.4")
- "target" = la valeur cible recommandee (ex: "-12 LUFS", "plat a 250Hz", "correlation > 0.7")
- Les taches doivent etre actionnables immediatement, pas "regarder des tutos"` : `- Dans "tips", donne 3 conseils concrets pour reproduire ce son dans ${daw}`}`;

  const prompt = isRef
    ? `Analyse la reference "${title}"${artist ? ' par ' + artist : ''}.\nDonnees audio: ${dataStr}\nDAW de l'utilisateur: ${daw}\n\nRemplace les "..." par de vraies valeurs. Suis exactement cette structure:\n${refTemplate}`
    : `Diagnostic du mix "${title}".\nDonnees audio: ${dataStr}\nDAW: ${daw}\n\nRemplace les "..." par de vraies valeurs. Suis exactement cette structure:\n${persoTemplate}`;

  // Timeout after 120 seconds
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

  // Find the first complete JSON object using brace counting
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON in response');
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
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
    // JSON truncated — try to fix by closing open braces/brackets
    console.warn('[claude] JSON truncated, attempting repair...');
    let repair = text.slice(start);
    // Remove trailing incomplete string value
    repair = repair.replace(/,\s*"[^"]*":\s*"[^"]*$/, '');
    repair = repair.replace(/,\s*"[^"]*$/, '');
    // Close open brackets and braces
    const openBraces = (repair.match(/\{/g) || []).length - (repair.match(/\}/g) || []).length;
    const openBrackets = (repair.match(/\[/g) || []).length - (repair.match(/\]/g) || []).length;
    for (let i = 0; i < openBrackets; i++) repair += ']';
    for (let i = 0; i < openBraces; i++) repair += '}';
    text = repair;
  } else {
    text = text.slice(start, end + 1);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
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
