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
  console.log('[fadr] assetId:', asset._id);

  onProgress?.('stems', 50);
  const r3 = await fetch(`${BASE}/assets/analyze/stem`, { method:'POST', headers:h(), body:JSON.stringify({ _id: asset._id }) });
  if (!r3.ok) throw new Error(`Fadr stem: ${r3.status}`);
  const { task } = await r3.json();
  console.log('[fadr] taskId:', task._id);

  // Poll until complete
  let result = task;
  let attempts = 0;
  while (!result.status?.complete && attempts < 24) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await fetch(`${BASE}/tasks/query`, {
      method:'POST', headers:h(),
      body:JSON.stringify({ _ids: [task._id] })
    });
    const data = await poll.json();
    result = data.tasks?.[0] || result;
    console.log('[fadr] poll', attempts, '— complete:', result.status?.complete, 'progress:', result.status?.progress);
    attempts++;
    onProgress?.('analyzing', Math.round(50 + Math.min(40, attempts * 1.7)));
  }

  // Fetch final asset with stems/midi/key/bpm
  console.log('[fadr] fetching final asset...');
  const ra = await fetch(`${BASE}/assets/${asset._id}`, {
    headers:{ 'Authorization':`Bearer ${process.env.FADR_API_KEY}` }
  });
  const finalAsset = ra.ok ? (await ra.json()).asset : asset;
  console.log('[fadr] final asset bpm:', finalAsset.bpm, 'key:', finalAsset.key);

  result.asset = finalAsset;
  onProgress?.('done', 100);
  return result;
}

function extractFadrData(task) {
  const a = task.asset || {};
  return { bpm:a.bpm||null, key:a.key||null, mode:a.mode||null, lufs:a.lufs||null, stems:a.stems||[], midi:a.midi||[], chords:a.chords||[], duration:a.duration||null };
}

module.exports = { analyzeFile, extractFadrData };
