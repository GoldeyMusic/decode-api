const fetch = require('node-fetch');
const MODEL = 'claude-sonnet-4-6';

async function generateFiche(fadrData, mode, daw, title, artist) {
  const isRef = mode === 'ref';
  const dataStr = fadrData ? 'BPM: ' + fadrData.bpm + ', Tonalite: ' + fadrData.key : 'Aucune donnee audio';

  const refTemplate = '{"elements":[{"cat":"BASSES","icon":"bass","items":[{"conf":"identified","label":"...","detail":"...","tools":["..."]}]},{"cat":"DRUMS","icon":"drums","items":[{"conf":"identified","label":"...","detail":"...","tools":["..."]}]},{"cat":"SYNTHS","icon":"synths","items":[{"conf":"suggested","label":"...","detail":"...","tools":["..."]}]},{"cat":"FX & ESPACE","icon":"fx","items":[{"conf":"suggested","label":"...","detail":"...","tools":["..."]}]}],"chain":[{"step":"INPUT","label":"...","c":"#F5A000"},{"step":"EQ","label":"...","c":"#57CC99"},{"step":"COMP","label":"...","c":"#E8A87C"},{"step":"REV","label":"...","c":"#9B59B6"},{"step":"OUT","label":"...","c":"#F5A000"}],"plugins":[{"name":"...","role":"...","free":false,"conf":"suggested"},{"name":"...","role":"...","free":true,"conf":"suggested"}],"tips":["...","...","..."],"summary":"..."}';

  const persoTemplate = '{"elements":[{"cat":"NIVEAU GLOBAL","icon":"lufs","items":[{"conf":"measured","label":"...","detail":"...","tools":["..."]}]},{"cat":"FREQUENCES","icon":"mids","items":[{"conf":"identified","label":"...","detail":"...","tools":["..."]}]},{"cat":"BASSE & KICK","icon":"bass","items":[{"conf":"identified","label":"...","detail":"...","tools":["..."]}]},{"cat":"ESPACE STEREO","icon":"stereo","items":[{"conf":"suggested","label":"...","detail":"...","tools":["..."]}]}],"chain":[{"step":"INPUT","label":"...","c":"#F5A000"},{"step":"EQ","label":"...","c":"#57CC99"},{"step":"COMP","label":"...","c":"#E8A87C"},{"step":"OUT","label":"...","c":"#F5A000"}],"plugins":[{"name":"...","role":"...","free":true,"conf":"suggested"},{"name":"...","role":"...","free":false,"conf":"suggested"}],"plan":[{"p":"HIGH","task":"...","daw":"..."},{"p":"MED","task":"...","daw":"..."}],"summary":"..."}';

  const prompt = isRef
    ? 'Analyse "' + title + '"' + (artist ? ' par ' + artist : '') + '. ' + dataStr + '. DAW: ' + daw + '.\n\nGenere un objet JSON en remplacant les "..." par de vraies valeurs. Suis exactement ce template:\n' + refTemplate
    : 'Analyse mix "' + title + '". ' + dataStr + '. DAW: ' + daw + '.\n\nGenere un objet JSON en remplacant les "..." par de vraies valeurs. Suis exactement ce template:\n' + persoTemplate;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: 'Expert production musicale. Reponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans backticks, sans commentaires.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error('Claude: ' + res.status);
  const data = await res.json();
  let text = data.content[0].text.trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON in Claude response');
  text = text.slice(start, end + 1);
  try {
    return JSON.parse(text);
  } catch(e) {
    console.error('[claude] parse error:', e.message, text.slice(0, 300));
    throw new Error('Claude JSON invalide: ' + e.message);
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
  if (!res.ok) throw new Error('Claude: ' + res.status);
  return (await res.json()).content[0].text;
}

module.exports = { generateFiche, chat };
