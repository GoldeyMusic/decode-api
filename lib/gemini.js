const fetch = require('node-fetch');

/**
 * Upload audio to Gemini File API (resumable upload protocol)
 * Returns the file URI to use in generateContent
 */
async function uploadToFileApi(fileBuffer, mimeType, displayName) {
  const apiKey = process.env.GEMINI_API_KEY;

  // Step 1: Initiate resumable upload
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

  // Step 2: Upload file bytes
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

async function analyzeListening(fileBuffer, mimeType, title, artist, fadrData, mode) {
  // fileBuffer is now a raw Buffer (not base64)
  const isRef = mode === 'ref';

  const prompt = isRef
    ? `Tu es un ingenieur du son expert. Ecoute "${title}" et donne ton analyse qualitative.
BPM ${fadrData?.bpm || 'N/A'}, Tonalite ${fadrData?.key || 'N/A'}.
Reponds UNIQUEMENT en JSON valide sans markdown:
{"impression":"ton ressenti general en 2-3 phrases","espace":"analyse de l'espace stereo et la profondeur","dynamique":"analyse de la dynamique et du loudness","couleur":"caractere sonore, texture, ambiance","signatures":["3 elements sonores signature du morceau"],"references":["2-3 artistes/morceaux avec un son similaire"],"mood":"le mood en un mot"}`
    : `Tu es un ingenieur du son expert. Ecoute ce mix "${title}" et donne ton diagnostic qualitatif.
Reponds UNIQUEMENT en JSON valide sans markdown:
{"impression":"ton ressenti general en 2-3 phrases","points_forts":["3-4 points forts du mix"],"a_travailler":["3-4 points a ameliorer avec des conseils concrets"],"espace":"analyse de l'espace stereo","dynamique":"analyse de la dynamique","potentiel":"potentiel du morceau et direction artistique suggeree"}`;

  // Upload file via File API
  console.log(`[gemini] uploading ${Math.round(fileBuffer.length / 1024)}KB via File API...`);
  const fileUri = await uploadToFileApi(fileBuffer, mimeType, title || 'audio');

  // Generate content with file reference
  const MAX_RETRIES = 3;
  const RETRY_CODES = [429, 503, 500];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      console.log(`[gemini] generateContent attempt ${attempt}/${MAX_RETRIES}...`);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
        const status = res.status;
        if (RETRY_CODES.includes(status) && attempt < MAX_RETRIES) {
          const wait = attempt * 5000;
          console.warn(`[gemini] ${status} — retry in ${wait / 1000}s...`);
          clearTimeout(timeout);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(`Listening API: ${status}`);
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
      clearTimeout(timeout);
      if (attempt === MAX_RETRIES) throw err;
      if (err.name === 'AbortError') throw new Error('Listening API: timeout (90s)');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { analyzeListening };
