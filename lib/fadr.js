const fetch = require('node-fetch');
const BASE = 'https://api.fadr.com';
const h = () => ({ 'Authorization':`Bearer ${process.env.FADR_API_KEY}`,'Content-Type':'application/json' });

async function analyzeFile(buffer, filename, extension, mimeType, onProgress) {
  onProgress?.('upload', 10);
  const r1 = await fetch(`${BASE}/assets/upload2`, { method:'POST', headers:h(), body:JSON.stringify({ name:filename, extension }) });
  if (!r1.ok) throw new Error(`Fadr upload2: ${r1.status}`);
  const { url, s3Path } = await r1.json();

  onProgress?.('upload', 30);
  await fetch(url, { method:'PUT', headers:{'Content-Type':mimeType}, body:buffer });

  const r2 = await fetch(`${BASE}/assets`, { method:'POST', headers:h(), body:JSON.stringify({ s3Path, name:filename, extension, group:`${filename}-group` }) });
  if (!r2.ok) throw new Error(`Fadr asset: ${r2.status}`);
  const { asset } = await r2.json();

  onProgress?.('stems', 50);
  const r3 = await fetch(`${BASE}/assets/analyze/stem`, { method:'POST', headers:h(), body:JSON.stringify({ _id: asset._id }) });
  if (!r3.ok) throw new Error(`Fadr stem: ${r3.status}`);
  const { task } = await r3.json();

  let result = task;
  let attempts = 0;
  while (!result.status?.complete && attempts < 30) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await fetch(`${BASE}/tasks/query`, { method:'POST', headers:h(), body:JSON.stringify({ _ids: [task._id] }) });
    const data = await poll.json();
    result = data.tasks?.[0] || result;
    attempts++;
    onProgress?.('analyzing', Math.round(50 + Math.min(40, attempts * 1.4)));
  }

  await new Promise(r => setTimeout(r, 3000));
  const ra = await fetch(`${BASE}/assets/${asset._id}`, { headers:{'Authorization':`Bearer ${process.env.FADR_API_KEY}`} });
  const finalAsset = ra.ok ? (await ra.json()).asset : asset;
  result.asset = finalAsset;
  onProgress?.('done', 100);
  return result;
}

// Normalisation enharmonique de la tonalite renvoyee par Fadr.
// Fadr utilise systematiquement les dieses ("D#:maj", "G#:maj", "Bb:min", ...)
// alors que la convention de lecture varie selon le mode :
//   - MAJEUR : on prefere les bemols quand l equivalent dieses n'a pas de
//     vraie tonalite standard (D# majeur = 9 dieses theoriques, Eb majeur
//     = 3 bemols, l ecriture standard). Idem A# → Bb, G# → Ab.
//   - MINEUR : on prefere les dieses (C# mineur, F# mineur, G# mineur)
//     plutot que leurs enharmoniques bemols qui sont rares.
// On normalise ici pour que l affichage et le prompt Claude soient lisibles
// en notation standard. Format de sortie : "Eb maj", "F# min", "C maj".
function normalizeKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return rawKey;
  const k = rawKey.trim();
  if (!k) return k;

  // Format Fadr "D#:maj" / "Bb:min" — sinon on tente de parser
  let note, modeRaw;
  if (k.includes(':')) {
    const parts = k.split(':');
    note = parts[0];
    modeRaw = (parts[1] || '').toLowerCase();
  } else {
    // Cas exotique "Am" / "C#m" / "Eb"
    const m = k.match(/^([A-G][b#]?)(m)?$/i);
    if (!m) return k;
    note = m[1];
    modeRaw = m[2] ? 'min' : 'maj';
  }
  const isMinor = modeRaw.startsWith('min');
  const modeStr = isMinor ? 'min' : 'maj';

  // Tables de conversion enharmonique selon le mode.
  const SHARP_TO_FLAT = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' };
  const FLAT_TO_SHARP = { 'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#' };
  // Convention pour chaque mode : quelle ecriture preferer pour les notes alterees.
  // MAJ : on bascule en bemols pour D#/A#/G# (Eb/Bb/Ab). On garde C# (Db rare en pop)
  //       et F# (Gb 6 bemols vs F# 6 dieses, on garde F# par habitude pop).
  // MIN : on bascule en dieses pour Db/Gb/Ab (C#/F#/G#). On garde Eb min et Bb min
  //       (ecritures standards en pop pour les modes mineurs).
  const MAJOR_PREFER_FLAT = new Set(['D#', 'A#', 'G#']);
  const MINOR_PREFER_SHARP = new Set(['Db', 'Gb', 'Ab']);

  let normNote = note;
  if (!isMinor && MAJOR_PREFER_FLAT.has(note)) normNote = SHARP_TO_FLAT[note];
  else if (isMinor && MINOR_PREFER_SHARP.has(note)) normNote = FLAT_TO_SHARP[note];

  return `${normNote} ${modeStr}`;
}

function extractFadrData(task) {
  const a = task.asset || {};
  const meta = a.metaData || {};

  // NOTE — limite connue de l API Fadr (DSP_PLAN, investigation 2026-04-27).
  // Cas observe : UI Fadr affiche "78bpm G maj" comme tonalite globale d un
  // morceau, mais l API /assets/analyze/stem renvoie meta.key="D:min" sur le
  // meme fichier. La timeline d accords UI (B min, D maj, G maj) est coherente
  // avec G majeur (I, iii, V), confirmant que la tonalite UI est la bonne et
  // que c est notre API qui est dans le faux.
  // Hypothese : cache cote Fadr (le meme fichier audio re-analyse plusieurs
  // fois renvoie la meme valeur erronee, puisque Fadr ne re-execute pas son
  // algorithme sur un hash deja vu). Confirme par test sur un autre titre :
  // Fadr a renvoye la bonne tonalite (D#:maj, normalisee Eb maj). Donc bug
  // ponctuel cote Fadr, pas systemique.
  // En attendant correction de leur cote : edition manuelle cote Versions
  // + detection maison en phase 2 (DSP_PLAN).

  const bpm = meta.tempo || a.bpm || null;
  const rawKey = meta.key || a.musicalKey || null;
  const key = rawKey ? normalizeKey(rawKey) : null;
  console.log('[fadr] extracted — bpm:', bpm, 'key:', key, rawKey && rawKey !== key ? `(raw: ${rawKey})` : '');
  return {
    bpm,
    key,
    lufs: meta.lufs || a.lufs || null,
    stems: a.stems || [],
    midi: a.midi || [],
    chords: meta.chords || a.chords || [],
    duration: meta.length ? Math.round(meta.length / meta.sampleRate) : null,
  };
}

module.exports = { analyzeFile, extractFadrData };
