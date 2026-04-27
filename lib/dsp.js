// lib/dsp.js
// Mesures DSP sur le master via ffmpeg ebur128 (conforme ITU-R BS.1770).
// Retourne LUFS intégré, LRA (Loudness Range) et True Peak — les 3 mesures
// objectives standard de l'industrie pour qualifier un master.
//
// Branche en parallèle de Fadr et Gemini dans le pipeline d'analyse
// (decode-api/api/analyze.js). Mode dégradé : retourne null si ffmpeg
// échoue ou timeout, le pipeline continue sans casser.

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { spawn } = require('child_process');

const TIMEOUT_MS = 60_000; // 60s max — un WAV 4 min se mesure en ~10-20s

/**
 * Calcule LUFS / LRA / True Peak d'un buffer audio via ffmpeg ebur128.
 * @param {Buffer} buffer audio (WAV/MP3/FLAC/etc., n'importe quel format
 *                        supporté par ffmpeg).
 * @returns {Promise<{ lufs: number|null, lra: number|null, truePeak: number|null }|null>}
 *          null si ffmpeg KO ou timeout (mode dégradé).
 */
function measureMaster(buffer) {
  return new Promise((resolve) => {
    if (!buffer || !buffer.length) {
      console.warn('[dsp] empty buffer');
      return resolve(null);
    }

    const t0 = Date.now();
    // -i pipe:0   : on lit le buffer depuis stdin
    // -af ebur128=peak=true : filter ITU-R BS.1770 + détection true peak
    // -f null -   : on jette la sortie audio, on ne veut que les stats stderr
    // -nostats    : moins de bruit dans stderr (on garde le summary final)
    const args = [
      '-hide_banner',
      '-nostats',
      '-i', 'pipe:0',
      '-af', 'ebur128=peak=true',
      '-f', 'null',
      '-',
    ];
    let proc;
    try {
      proc = spawn(ffmpegPath, args);
    } catch (e) {
      console.error('[dsp] spawn error:', e.message);
      return resolve(null);
    }

    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[dsp] timeout ${TIMEOUT_MS / 1000}s, killing ffmpeg`);
      try { proc.kill('SIGKILL'); } catch {}
    }, TIMEOUT_MS);

    proc.stdin.on('error', (e) => {
      // EPIPE possible si ffmpeg ferme stdin tôt — non bloquant
      if (e.code !== 'EPIPE') console.warn('[dsp] stdin error:', e.message);
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      console.error('[dsp] proc error:', e.message);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve(null);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (code !== 0) {
        console.warn(`[dsp] ffmpeg exit ${code} in ${elapsed}s, last stderr: ${stderr.slice(-300)}`);
        return resolve(null);
      }
      const parsed = parseEbur128(stderr);
      console.log(`[dsp] master measured in ${elapsed}s — lufs:${parsed.lufs} lra:${parsed.lra} truePeak:${parsed.truePeak}`);
      resolve(parsed);
    });

    // Pipe buffer dans stdin
    try {
      proc.stdin.write(buffer);
      proc.stdin.end();
    } catch (e) {
      console.warn('[dsp] write error:', e.message);
    }
  });
}

/**
 * Parse la sortie stderr de ffmpeg ebur128 pour extraire les valeurs finales
 * du bloc "Summary:". Format ffmpeg :
 *
 *   [Parsed_ebur128_0 @ ...] Summary:
 *
 *     Integrated loudness:
 *       I:         -8.6 LUFS
 *       Threshold: -19.6 LUFS
 *
 *     Loudness range:
 *       LRA:         6.4 LU
 *
 *     True peak:
 *       Peak:       -0.3 dBFS
 *
 * On prend le DERNIER "Summary:" (lastIndexOf) car ffmpeg peut en émettre
 * plusieurs si plusieurs filtres ebur128 sont chaînés (rare mais possible).
 */
function parseEbur128(stderr) {
  const sumIdx = stderr.lastIndexOf('Summary:');
  const block = sumIdx >= 0 ? stderr.slice(sumIdx) : stderr;

  const findFloat = (re) => {
    const m = block.match(re);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  return {
    lufs: findFloat(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/),
    lra: findFloat(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/),
    // Selon la version de ffmpeg, le label peut être "Peak:" ou "True peak max:"
    truePeak: findFloat(/(?:True peak[\s\S]*?(?:Peak|max):|Peak:)\s*(-?\d+(?:\.\d+)?)\s*dB/),
  };
}

module.exports = { measureMaster };
