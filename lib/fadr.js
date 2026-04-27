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

function extractFadrData(task) {
  const a = task.asset || {};
  const meta = a.metaData || {};

  // NOTE — limite connue de l API Fadr (DSP_PLAN, investigation 2026-04-27).
  // Cas observe : UI Fadr affiche "78bpm G maj" comme tonalite globale d un
  // morceau, mais l API /assets/analyze/stem renvoie meta.key="D:min" sur le
  // meme fichier. La timeline d accords UI (B min, D maj, G maj) est coherente
  // avec G majeur (I, iii, V), confirmant que la tonalite UI est la bonne et
  // que c est notre API qui est dans le faux. Pas de champ alternatif dans
  // l asset Fadr (verifie en dumpant toutes les cles).
  // A explorer en phase 2 : endpoint dedie type "Key Finder" si Fadr en
  // expose un (vu comme feature distincte sur leur UI). En attendant :
  // edition manuelle cote Versions + detection maison en phase 2.

  const bpm = meta.tempo || a.bpm || null;
  const key = meta.key || a.musicalKey || null;
  console.log('[fadr] extracted — bpm:', bpm, 'key:', key);
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
