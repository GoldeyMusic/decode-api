const fetch = require('node-fetch');
const BASE = 'https://api.fadr.com';
const h = () => ({ 'Authorization':`Bearer ${process.env.FADR_API_KEY}`,'Content-Type':'application/json' });
async function analyzeFile(buffer, filename, extension, mimeType, onProgress) {
  onProgress?.('upload',10);
  const r1 = await fetch(`${BASE}/assets/upload2`,{ method:'POST',headers:h(),body:JSON.stringify({ name:filename,extension }) });
  if(!r1.ok) throw new Error(`Fadr upload2: ${r1.status}`);
  const { url, s3Path } = await r1.json();
  onProgress?.('upload',30);
  await fetch(url,{ method:'PUT',headers:{'Content-Type':mimeType},body:buffer });
  const r2 = await fetch(`${BASE}/assets`,{ method:'POST',headers:h(),body:JSON.stringify({ s3Path,name:filename,extension }) });
  if(!r2.ok) throw new Error(`Fadr asset: ${r2.status}`);
  const asset = await r2.json();
  onProgress?.('stems',50);
  const r3 = await fetch(`${BASE}/tasks/stem`,{ method:'POST',headers:h(),body:JSON.stringify({ assetId:asset._id,stemType:'main' }) });
  if(!r3.ok) throw new Error(`Fadr stem: ${r3.status}`);
  const task = await r3.json();
  let result = task, attempts = 0;
  while(result.status !== 'complete' && attempts < 24) {
    await new Promise(r=>setTimeout(r,5000));
    const poll = await fetch(`${BASE}/tasks/${task._id}`,{ headers:{'Authorization':`Bearer ${process.env.FADR_API_KEY}`} });
    result = await poll.json(); attempts++;
    onProgress?.('analyzing', Math.round(50+Math.min(40,attempts*1.7)));
  }
  if(result.status !== 'complete') throw new Error('Fadr timeout');
  onProgress?.('done',100);
  return result;
}
function extractFadrData(task) {
  const a = task.asset||{};
  return { bpm:a.bpm||null,key:a.key||null,mode:a.mode||null,lufs:a.lufs||null,stems:a.stems||[],midi:a.midi||[],chords:a.chords||[],duration:a.duration||null };
}
module.exports = { analyzeFile, extractFadrData };
