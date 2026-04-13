const fetch = require('node-fetch');

/**
 * Upload audio to Gemini File API (resumable upload protocol).
 * Returns the file URI to use in generateContent.
 */
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

/**
 * Single generateContent call on a given model. Throws an Error with .status
 * set for HTTP failures so the caller can decide whether to retry.
 */
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
    try {
      return JSON.parse(text);
    } catch {
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

/**
 * Try gemini-2.5-flash first (4 retries with exponential backoff + jitter),
 * then fall back to gemini-2.5-pro if all flash attempts fail. The file is
 * uploaded once and reused across all attempts.
 */
async function analyzeListening(fileBuffer, mimeType, title, artist, fadrData, mode) {
  const isRef = mode === 'ref';
  const prompt = isRef
    ? `Tu es un ingenieur du son expert. Ecoute "${title}" et donne ton analyse qualitative.
BPM ${fadrData?.bpm || 'N/A'}, Tonalite ${fadrData?.key || 'N/A'}.
Reponds UNIQUEMENT en JSON valide sans markdown:
{"impression":"ton ressenti general en 2-3 phrases","espace":"analyse de l'espace stereo et la profondeur","dynamique":"analyse de la dynamique et du loudness","couleur":"caractere sonore, texture, ambiance","signatures":["3 elements sonores signature du morceau"],"references":["2-3 artistes/morceaux avec un son similaire"],"mood":"le mood en un mot"}`
    : `Tu es un ingenieur du son expert. Ecoute ce mix "${title}" et donne ton diagnostic qualitatif.
Reponds UNIQUEMENT en JSON valide sans markdown:
{"impression":"ton ressenti general en 2-3 phrases","points_forts":["3-4 points forts du mix"],"a_travailler":["3-4 points a ameliorer avec des conseils concrets"],"espace":"analyse de l'espace stereo","dynamique":"analyse de la dynamique","potentiel":"potentiel du morceau et direction artistique suggeree"}`;

  console.log(`[gemini] uploading ${Math.round(fileBuffer.length / 1024)}KB via File API...`);
  const fileUri = await uploadToFileApi(fileBuffer, mimeType, title || 'audio');

  const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];
  const RETRY_CODES = [429, 500, 502, 503, 504];
  const MAX_ATTEMPTS_PER_MODEL = 4;

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
        const status = err.status;
        const isTransient = status && RETRY_CODES.includes(status);

        if (!isTransient) {
          console.warn(`[gemini] ${model} non-retryable error: ${err.message}`);
          break;
        }

        if (attempt < MAX_ATTEMPTS_PER_MODEL) {
          const base = Math.min(3000 * Math.pow(2, attempt - 1), 30000);
          const jitter = Math.floor(Math.random() * 1500);
          const wait = base + jitter;
          console.warn(`[gemini] ${model} ${status} — retry in ${(wait / 1000).toFixed(1)}s...`);
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
