const fetch = require('node-fetch');

async function analyzeListening(fileBase64, mimeType, title, artist, fadrData, mode) {
  const isRef = mode === 'ref';

  const prompt = isRef
    ? `Tu es un ingenieur du son expert. Ecoute "${title}" et donne ton analyse qualitative.
BPM ${fadrData?.bpm || 'N/A'}, Tonalite ${fadrData?.key || 'N/A'}.
Reponds UNIQUEMENT en JSON valide sans markdown:
{"impression":"ton ressenti general en 2-3 phrases","espace":"analyse de l'espace stereo et la profondeur","dynamique":"analyse de la dynamique et du loudness","couleur":"caractere sonore, texture, ambiance","signatures":["3 elements sonores signature du morceau"],"references":["2-3 artistes/morceaux avec un son similaire"],"mood":"le mood en un mot"}`
    : `Tu es un ingenieur du son expert. Ecoute ce mix "${title}" et donne ton diagnostic qualitatif.
Reponds UNIQUEMENT en JSON valide sans markdown:
{"impression":"ton ressenti general en 2-3 phrases","points_forts":["3-4 points forts du mix"],"a_travailler":["3-4 points a ameliorer avec des conseils concrets"],"espace":"analyse de l'espace stereo","dynamique":"analyse de la dynamique","potentiel":"potentiel du morceau et direction artistique suggeree"}`;

  const MAX_RETRIES = 3;
  const RETRY_CODES = [429, 503, 500];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      console.log(`[gemini] attempt ${attempt}/${MAX_RETRIES}...`);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: mimeType, data: fileBase64 } },
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
          const wait = attempt * 5000; // 5s, 10s
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
