const fetch = require('node-fetch');
const MODEL = 'claude-sonnet-4-6';
async function generateFiche(fadrData, mode, daw, title, artist) {
  const isRef = mode==='ref';
  const dataStr = fadrData ? JSON.stringify(fadrData,null,2) : 'Aucune donnée audio';
  const prompt = isRef
    ? `Analyse "${title}"${artist?' par '+artist:''}.\nDonnées Fadr:\n${dataStr}\n\nMODE RÉFÉRENCE. JSON: {"elements":[{"cat":"BASSES|DRUMS|SYNTHS|FX & ESPACE","icon":"bass|drums|synths|fx","items":[{"conf":"measured|identified|suggested","label":"...","detail":"...","tools":["..."]}]}],"chain":[{"step":"INPUT|EQ|COMP|SAT|REV|OUT","label":"...","c":"#hex"}],"plugins":[{"name":"...","role":"...","free":false,"conf":"identified"}],"tips":["conseil pour ${daw}"],"summary":"..."}`
    : `Analyse "${title}".\nDonnées Fadr:\n${dataStr}\n\nMODE PERSONNEL. JSON: {"elements":[{"cat":"NIVEAU GLOBAL|FRÉQUENCES|BASSE & KICK|ESPACE STÉRÉO|DYNAMIQUE","icon":"lufs|mids|bass|stereo|dynamics","items":[{"conf":"measured|identified|suggested","label":"...","detail":"...","tools":["..."]}]}],"chain":[{"step":"...","label":"...","c":"#hex"}],"plugins":[{"name":"...","role":"...","free":true,"conf":"suggested"}],"plan":[{"p":"HIGH|MED|LOW","task":"...","daw":"comment faire dans ${daw}"}],"summary":"..."}`;
  const res = await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST', headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({ model:MODEL, max_tokens:2000, system:`Expert prod musicale. DAW: ${daw}. JSON valide uniquement, sans markdown.`, messages:[{role:'user',content:prompt}] })
  });
  if(!res.ok) throw new Error(`Claude: ${res.status}`);
  const data = await res.json();
  const text = data.content[0].text;
  try { return JSON.parse(text); } catch { const m=text.match(/\{[\s\S]*\}/); if(m) return JSON.parse(m[0]); throw new Error('JSON invalide'); }
}
async function chat(messages, system) {
  const res = await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST', headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    body:JSON.stringify({ model:MODEL, max_tokens:800, system, messages })
  });
  if(!res.ok) throw new Error(`Claude: ${res.status}`);
  return (await res.json()).content[0].text;
}
module.exports = { generateFiche, chat };
