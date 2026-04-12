const fetch = require('node-fetch');
async function analyzeListening(fileBase64, mimeType, title, artist, fadrData, mode) {
  const isRef = mode==='ref';
  const prompt = isRef
    ? `Analyse "${title}". BPM ${fadrData?.bpm||'N/A'}, Tonalité ${fadrData?.key||'N/A'}. JSON: {"impression":"...","espace":"...","dynamique":"...","couleur":"...","signatures":["..."],"references":["..."],"mood":"..."}`
    : `Mix "${title}". JSON: {"impression":"...","points_forts":["..."],"a_travailler":["..."],"espace":"...","dynamique":"...","potentiel":"..."}`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ contents:[{ parts:[{inline_data:{mime_type:mimeType,data:fileBase64}},{text:prompt}] }] })
  });
  if(!res.ok) throw new Error(`Gemini: ${res.status}`);
  const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text||'';
  try { return JSON.parse(text); } catch { const m=text.match(/\{[\s\S]*\}/); if(m) return JSON.parse(m[0]); throw new Error('Gemini JSON invalide'); }
}
module.exports = { analyzeListening };
