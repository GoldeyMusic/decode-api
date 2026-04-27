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

  // ── Debug dump temporaire (DSP investigation) ──────────────────
  // On a observe une divergence entre la tonalite renvoyee par notre
  // pipeline (D:min) et celle affichee par l UI Fadr (G:maj) sur le
  // meme fichier. Hypothese : on lit le mauvais champ. On dump ici
  // toutes les clefs disponibles pour identifier le bon champ.
  // A retirer quand le bon champ aura ete identifie.
  try {
    const assetTopKeys = Object.keys(a);
    const metaTopKeys = Object.keys(meta);
    // Filtre des cles qui pourraient porter une tonalite ou une mesure
    const interesting = (obj, prefix) => Object.entries(obj || {})
      .filter(([k]) => /key|tonal|loud|lufs|lra|peak|tempo|bpm|crest|dynamic|scale|mode/i.test(k))
      .map(([k, v]) => `${prefix}.${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : v}`);
    console.log('[fadr-debug] asset top keys:', assetTopKeys.join(','));
    console.log('[fadr-debug] meta top keys:', metaTopKeys.join(','));
    console.log('[fadr-debug] asset interesting fields:', interesting(a, 'asset').join(' | ') || '(none)');
    console.log('[fadr-debug] meta interesting fields:', interesting(meta, 'meta').join(' | ') || '(none)');
  } catch (e) {
    console.warn('[fadr-debug] dump failed:', e.message);
  }

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
