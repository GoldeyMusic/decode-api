const fetch = require('node-fetch');
 
async function uploadToFileApi(fileBuffer, mimeType, displayName) {
  const apiKey = process.env.GEMINI_API_KEY;
  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileBuffer.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    }
  );
  if (!initRes.ok) {
    const err = await initRes.text().catch(() => '');
    throw new Error(`File API init: ${initRes.status} ${err.slice(0, 200)}`);
  }
  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('File API: no upload URL returned');
 
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(fileBuffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: fileBuffer,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => '');
    throw new Error(`File API upload: ${uploadRes.status} ${err.slice(0, 200)}`);
  }
  const fileInfo = await uploadRes.json();
  const fileUri = fileInfo.file?.uri;
  if (!fileUri) throw new Error('File API: no file URI in response');
  console.log(`[gemini] file uploaded: ${fileUri}`);
  return fileUri;
}
 
async function callGenerate(model, fileUri, mimeType, prompt, timeoutMs = 90000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { file_data: { file_uri: fileUri, mime_type: mimeType } },
              { text: prompt },
            ],
          }],
        }),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`Listening API: ${res.status}${body ? ' — ' + body.slice(0, 200) : ''}`);
      e.status = res.status;
      throw e;
    }
    const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
    try { return JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Listening JSON invalide');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Listening API: timeout (${timeoutMs / 1000}s)`);
      e.status = 0;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
 
function buildPrompt(mode, title) {
  if (mode === 'ref') {
    return `Tu es ingenieur du son experimente. Le user veut comprendre comment reproduire le son de "${title}". Ecoute-le attentivement.
 
DIRECTIVES:
- Parle comme un ingenieur du son qui decrit un morceau a un collegue.
- Sois specifique sur les textures, les plages de frequences, les effets caracteristiques.
- Pas de noms de plugins, reste sur les techniques et le son.
- Si le morceau est instrumental, ne parle pas de voix.
- "VOIX" couvre aussi bien les leads que les choeurs/backing vocals.
 
JSON strict (aucun markdown):
{
  "impression": "2-4 phrases sur l identite sonore et ton ressenti.",
  "signatures": ["3-5 elements sonores signature precis et identifiables"],
  "espace": "analyse stereo et profondeur, 2-3 phrases specifiques.",
  "dynamique": "analyse dynamique et loudness percu, 2-3 phrases.",
  "couleur": "caractere, texture, ambiance en une phrase riche.",
  "references": ["2-4 artistes ou morceaux au son proche"],
  "mood": "le mood en un mot"
}`;
  }
 
  return `Tu es ingenieur du son expert et A&R. Tu viens d ecouter ce morceau "${title}". Ecris ton retour comme tu le ferais a un artiste que tu respectes: honnete, precis, nuance. Tu peux dire quand c est bien ET quand c est perfectible, sans forcer l un ou l autre.
 
DIRECTIVES IMPORTANTES:
1. Commence par TON impression reelle. Si le mix est deja propre, dis-le ("on sent le travail", "c est deja bien avance"). Ne rentre pas direct dans les problemes.
2. Ne force PAS des "a_travailler" s il n y a rien de majeur. Cette liste peut avoir 0, 1, 2 ou 3 items, selon ce que tu entends vraiment. Si tout est propre, laisse-la VIDE.
3. Sois SPECIFIQUE: cite des moments du morceau ("vers 1:24", "au solo"), des elements identifies ("caisse claire", "pad arriere", "guitare clean"), des frequences seulement quand tu es sur.
4. Si le morceau est INSTRUMENTAL et qu il n y a pas de voix, n en parle pas. Ne dis pas "voix a traiter".
5. "VOIX" inclut les leads ET les choeurs/backing vocals. Precise de quelle voix tu parles quand c est utile.
6. Tes observations doivent refleter ce que TU entends, pas des generalites.
7. Termine par un verdict franc dans "potentiel": est-ce pret, presque pret, ou encore du travail, et dans quelle direction.
 
JSON strict (aucun markdown, aucun backtick):
{
  "impression": "2-4 phrases d ouverture personnelles et specifiques, tutoyant l artiste.",
  "points_forts": ["3-6 observations concretes de ce qui fonctionne, avec des details du morceau"],
  "a_travailler": ["0 a 3 vraies pistes a creuser. VIDE si le mix est deja pret. Chaque item pointe un element precis et suggere une direction sans dicter un plugin."],
  "espace": "image stereo, profondeur, plans. 2-3 phrases specifiques au morceau.",
  "dynamique": "dynamique, respiration, compression percue. 2-3 phrases specifiques.",
  "potentiel": "une phrase franche de verdict et direction artistique perçue.",
  "mood": "le mood en un mot"
}`;
}
 
async function analyzeListening(fileBuffer, mimeType, title, artist, mode) {
  const prompt = buildPrompt(mode, title || 'ce morceau');
 
  console.log(`[gemini] uploading ${Math.round(fileBuffer.length / 1024)}KB via File API...`);
  const fileUri = await uploadToFileApi(fileBuffer, mimeType, title || 'audio');
 
  const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];
  const RETRY_CODES = [429, 500, 502, 503, 504];
  const MAX_ATTEMPTS_PER_MODEL = 2;
  let lastError = null;
 
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        console.log(`[gemini] ${model} attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL}...`);
        const result = await callGenerate(model, fileUri, mimeType, prompt);
        console.log(`[gemini] ${model} success on attempt ${attempt}`);
        return result;
      } catch (err) {
        lastError = err;
        const isTransient = err.status && RETRY_CODES.includes(err.status);
        if (!isTransient) {
          console.warn(`[gemini] ${model} non-retryable: ${err.message}`);
          break;
        }
        if (attempt < MAX_ATTEMPTS_PER_MODEL) {
          const wait = Math.min(3000 * Math.pow(2, attempt - 1), 30000) + Math.floor(Math.random() * 1500);
          console.warn(`[gemini] ${model} ${err.status} — retry in ${(wait / 1000).toFixed(1)}s...`);
          await new Promise(r => setTimeout(r, wait));
        } else {
          console.warn(`[gemini] ${model} exhausted retries, trying next model...`);
        }
      }
    }
  }
  throw lastError || new Error('Listening API: all models unavailable');
}
 
module.exports = { analyzeListening };
