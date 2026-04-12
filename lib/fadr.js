const fetch = require('node-fetch');
const BASE = 'https://api.fadr.com';
const h = () => ({ 'Authorization':`Bearer ${process.env.FADR_API_KEY}`,'Content-Type':'application/json' });

async function analyzeFile(buffer, filename, extension, mimeType, onProgress) {
  onProgress?.('upload', 10);

  const r1 = await fetch(`${BASE}/assets/upload2`, {
    method:'POST', headers:h(),
    body:JSON.stringify({ name:filename, extension })
  });
  if (!r1.ok) throw new Error(`Fadr upload2: ${r1.status}`);
  const upload = await r1.json();
  console.log('[fadr] upload2 response:', JSON.stringify(upload));
  const { url, s3Path } = upload;

  onProgress?.('upload', 30);
  const s3 = await fetch(url, { method:'PUT', headers:{'Content-Type':mimeType}, body:buffer });
  console.log('[fadr] S3 PUT status:', s3.status);

  const r2 = await fetch(`${BASE}/assets`, {
    method:'POST', headers:h(),
    body:JSON.stringify({ s3Path, name:filename, extension, group:`${filename}-group` })
  });
  if (!r2.ok) throw new Error(`Fadr asset: ${r2.status}`);
  const assetResp = await r2.json();
  console.log('[fadr] create asset response:', JSON.stringify(assetResp));

  const assetId = assetResp.asset?._id || assetResp._id;
  console.log('[fadr] assetId:', assetId);

  onProgress?.('stems', 50);
  const r3 = await fetch(`${BASE}/assets/analyze/stem`, {
    method:'POST', headers:h(),
    body:JSON.stringify({ _id: assetId })
  });
  const r3text = await r3.text();
  console.log('[fadr] stem status:', r3.status, r3text);
  if (!r3.ok) throw new Error(`Fadr stem: ${r3.status} — ${r3text}`);
  const { task } = JSON.parse(r3text);

  let result = task;
  let attempts = 0;
  while (!result.asset?.stems?.length && attempts < 24) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await fetch(`${BASE}/tasks/query`, {
      method:'POST', headers:h(),
      body:JSON.stringify({ _ids: [task._id] })
    });
    const data = await poll.json();
    result = data.tasks?.[0] || result;
    attempts++;
    onProgress?.('analyzing', Math.round(50 + Math.min(40, attempts * 1.7)));
  }

  onProgress?.('done', 100);
  return result;
}

function extractFadrData(task) {
  const a = task.asset || {};
  return { bpm:a.bpm||null, key:a.key||null, mode:a.mode||null, lufs:a.lufs||null, stems:a.stems||[], midi:a.midi||[], chords:a.chords||[], duration:a.duration||null };
}

module.exports = { analyzeFile, extractFadrData };
