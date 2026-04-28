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

/**
 * DSP_PLAN B.2 — mesure DSP par stem.
 * Calcule {lufs, truePeak, peak, energyBand_5_8kHz, energyBand_1_3kHz} pour
 * un stem (vocal/drums/bass/other). Les bandes 1-3 kHz et 5-8 kHz sont
 * spécifiquement pertinentes pour le stem voix (présence + sibilantes) ;
 * sur les autres stems elles servent de proxy énergétique.
 *
 * Stratégie : un seul ffmpeg par mesure (3 ffmpeg total : ebur128 + 2 bandpass).
 * Lancés en parallèle via Promise.all. Mode dégradé champ par champ : si une
 * mesure échoue, son champ est null mais les autres restent valides.
 *
 * @param {Buffer} buffer — audio du stem (n'importe quel format ffmpeg)
 * @param {string} [label] — étiquette pour les logs (ex. "vocal", "drums")
 * @returns {Promise<{lufs, truePeak, peak, energyBand_5_8kHz, energyBand_1_3kHz}|null>}
 */
async function measureStem(buffer, label = 'stem') {
  if (!buffer || !buffer.length) {
    console.warn(`[dsp.measureStem:${label}] empty buffer`);
    return null;
  }
  const t0 = Date.now();
  const [master, sibilants, presence] = await Promise.all([
    measureMaster(buffer),                                // lufs + lra + truePeak
    measureBandEnergy(buffer, 6500, 3000, `${label}/5-8k`), // 5-8 kHz : sibilantes
    measureBandEnergy(buffer, 2000, 2000, `${label}/1-3k`), // 1-3 kHz : présence
  ]);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const result = {
    lufs: master?.lufs ?? null,
    // LRA n'a pas vraiment de sens sur un stem isolé (souvent < 1s d'air),
    // on l'omet du résultat. Conservé sur measureMaster pour le bus master.
    truePeak: master?.truePeak ?? null,
    peak: sibilants?.peak ?? presence?.peak ?? null, // peak large bande
    energyBand_5_8kHz: sibilants?.rms ?? null,        // dB mean — proxy sibilantes
    energyBand_1_3kHz: presence?.rms ?? null,         // dB mean — proxy présence
  };
  console.log(`[dsp.measureStem:${label}] ${elapsed}s — lufs:${result.lufs} truePeak:${result.truePeak} band5-8k:${result.energyBand_5_8kHz} band1-3k:${result.energyBand_1_3kHz}`);
  return result;
}

/**
 * Mesure l'énergie RMS (mean_volume) d'une bande de fréquence via
 * `bandpass` (filtre IIR Butterworth) + `volumedetect` (RMS overall).
 * Renvoie aussi le peak post-bandpass au passage (utile pour le stem
 * complet en fallback).
 *
 * @param {Buffer} buffer
 * @param {number} centerHz — centre de la bande (ex. 6500 pour 5-8 kHz)
 * @param {number} widthHz  — largeur (ex. 3000 → bande [centre±width/2])
 * @param {string} [label]  — pour logs
 * @returns {Promise<{rms: number|null, peak: number|null}|null>}
 *          rms et peak en dB (négatifs, 0 = full scale).
 */
function measureBandEnergy(buffer, centerHz, widthHz, label = 'band') {
  return new Promise((resolve) => {
    if (!buffer || !buffer.length) return resolve(null);
    const af = `bandpass=f=${centerHz}:width_type=h:w=${widthHz},volumedetect`;
    const args = [
      '-hide_banner', '-nostats',
      '-i', 'pipe:0',
      '-af', af,
      '-f', 'null', '-',
    ];
    let proc;
    try { proc = spawn(ffmpegPath, args); }
    catch (e) {
      console.warn(`[dsp.band:${label}] spawn error:`, e.message);
      return resolve(null);
    }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, TIMEOUT_MS);
    proc.stdin.on('error', (e) => {
      if (e.code !== 'EPIPE') console.warn(`[dsp.band:${label}] stdin:`, e.message);
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      console.warn(`[dsp.band:${label}] proc:`, e.message);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve(null);
      if (code !== 0) {
        console.warn(`[dsp.band:${label}] exit ${code}, last stderr: ${stderr.slice(-200)}`);
        return resolve(null);
      }
      // volumedetect output :
      //   [Parsed_volumedetect_1 @ ...] mean_volume: -22.5 dB
      //   [Parsed_volumedetect_1 @ ...] max_volume: -1.5 dB
      const parseFloatOrNull = (re) => {
        const m = stderr.match(re);
        if (!m) return null;
        const n = parseFloat(m[1]);
        return Number.isFinite(n) ? n : null;
      };
      resolve({
        rms: parseFloatOrNull(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/),
        peak: parseFloatOrNull(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/),
      });
    });
    try {
      proc.stdin.write(buffer);
      proc.stdin.end();
    } catch (e) {
      console.warn(`[dsp.band:${label}] write:`, e.message);
    }
  });
}

/**
 * DSP_PLAN B.3 — mesure du champ stéréo sur le master.
 * Renvoie corrélation L/R (-1 à +1), Mid/Side ratio (% d'énergie M vs S),
 * balance L/R (différence d'énergie entre canaux en dB) et mono compat
 * (delta LUFS entre stéréo et version mixée en mono — proche de 0 = mix
 * tient en mono, > 1 LU = problèmes de phase / annulations en mono).
 *
 * Stratégie : 2 ffmpeg en parallèle.
 *  1. astats sur le master stéréo → corrélation L/R + RMS par canal.
 *  2. ebur128 sur le mix mono (pan=1c|c0=0.5*c0+0.5*c1) → LUFS mono.
 * Combiné avec le LUFS stéréo passé en argument (déjà mesuré par
 * measureMaster) pour calculer mono_compat = LUFS_stereo − LUFS_mono.
 *
 * @param {Buffer} buffer
 * @param {number} [stereoLufs] — LUFS stéréo déjà mesuré (évite de refaire
 *                                ebur128 inutilement). Si absent, on le
 *                                calcule à la volée.
 * @returns {Promise<{
 *   correlation: number|null,         // -1 à +1
 *   midSideRatio: number|null,        // 0-1 : part d'énergie sur le côté
 *   balanceLR: number|null,           // dB : RMS_L − RMS_R (positif = plus à gauche)
 *   monoCompat: number|null,          // LU : LUFS_stereo − LUFS_mono
 * }|null>}
 */
async function measureStereoField(buffer, stereoLufs = null) {
  if (!buffer || !buffer.length) return null;
  const t0 = Date.now();
  // Lance les 2 ffmpeg en parallèle. Si stereoLufs absent, on relance
  // measureMaster aussi (au pire 3 spawns).
  const tasks = [
    measureStereoStats(buffer),
    measureMonoLufs(buffer),
  ];
  if (stereoLufs == null) tasks.push(measureMaster(buffer));
  const [stats, monoMaster, freshMaster] = await Promise.all(tasks);
  const lufsStereo = stereoLufs ?? freshMaster?.lufs ?? null;
  const lufsMono = monoMaster?.lufs ?? null;
  const monoCompat = (lufsStereo != null && lufsMono != null)
    ? +(lufsStereo - lufsMono).toFixed(2)
    : null;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const result = {
    correlation: stats?.correlation ?? null,
    midSideRatio: stats?.midSideRatio ?? null,
    balanceLR: stats?.balanceLR ?? null,
    monoCompat,
  };
  console.log(`[dsp.stereo] ${elapsed}s — corr:${result.correlation} M/S:${result.midSideRatio} bal:${result.balanceLR} monoCompat:${result.monoCompat}`);
  return result;
}

/**
 * astats sur le master pour corrélation L/R + RMS par canal.
 * Sortie astats (par canal) :
 *   [Parsed_astats_0 @ ...] Channel: 1
 *   [Parsed_astats_0 @ ...] RMS level dB: -16.4
 *   [Parsed_astats_0 @ ...] Channel: 2
 *   [Parsed_astats_0 @ ...] RMS level dB: -16.7
 *   [Parsed_astats_0 @ ...] Overall:
 *   [Parsed_astats_0 @ ...] RMS level dB: -16.5
 *   [Parsed_astats_0 @ ...] ... and a "Cross corr.: 0.85" si stéréo.
 */
function measureStereoStats(buffer) {
  return new Promise((resolve) => {
    // astats : measure_perchannel + measure_overall pour avoir RMS par canal.
    // length=0 = analyse tout (default 0 mais on l'explicite).
    const args = [
      '-hide_banner', '-nostats',
      '-i', 'pipe:0',
      '-af', 'astats=length=0:metadata=0',
      '-f', 'null', '-',
    ];
    let proc;
    try { proc = spawn(ffmpegPath, args); }
    catch (e) { console.warn('[dsp.stereoStats] spawn:', e.message); return resolve(null); }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    proc.stdin.on('error', (e) => { if (e.code !== 'EPIPE') console.warn('[dsp.stereoStats] stdin:', e.message); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); console.warn('[dsp.stereoStats] proc:', e.message); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) return resolve(null);
      resolve(parseStereoStats(stderr));
    });
    try { proc.stdin.write(buffer); proc.stdin.end(); }
    catch (e) { console.warn('[dsp.stereoStats] write:', e.message); }
  });
}

/**
 * Parse la sortie astats pour extraire :
 *  - RMS L (Channel 1) et RMS R (Channel 2) en dB
 *  - Corrélation (cherche "Cross corr." ou "Inter-correlation")
 *  - Mid/Side ratio dérivé : si on a RMS L et RMS R, on estime via la corrélation.
 *
 * Note : astats expose la corrélation cross-canal sous `Cross corr.` depuis
 * ffmpeg 4.4. Sur les versions plus anciennes, on retourne null pour ce champ.
 * Le mid/side ratio est estimé à partir de la corrélation :
 *   M = (L+R)/2, S = (L-R)/2
 *   |S|² / (|M|² + |S|²) ≈ (1-corr) / 2 si L et R ont même énergie.
 */
function parseStereoStats(stderr) {
  const findFloat = (re) => {
    const m = stderr.match(re);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  // Sépare les blocs par canal. astats imprime "Channel: 1" puis ses lignes
  // RMS, "Channel: 2" puis ses lignes RMS, puis "Overall:".
  const ch1Idx = stderr.indexOf('Channel: 1');
  const ch2Idx = stderr.indexOf('Channel: 2', ch1Idx + 1);
  const overallIdx = stderr.indexOf('Overall:', ch2Idx + 1);
  let rmsL = null, rmsR = null;
  if (ch1Idx >= 0 && ch2Idx > ch1Idx) {
    const ch1Block = stderr.slice(ch1Idx, ch2Idx);
    rmsL = (ch1Block.match(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/) || [])[1];
    rmsL = rmsL != null ? parseFloat(rmsL) : null;
  }
  if (ch2Idx >= 0) {
    const ch2End = overallIdx > ch2Idx ? overallIdx : stderr.length;
    const ch2Block = stderr.slice(ch2Idx, ch2End);
    rmsR = (ch2Block.match(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/) || [])[1];
    rmsR = rmsR != null ? parseFloat(rmsR) : null;
  }
  // Corrélation : sortie ffmpeg "Cross corr.: 0.876543"
  const correlation = findFloat(/Cross corr(?:elation)?\.?:\s*(-?\d+(?:\.\d+)?)/);
  // Balance L/R en dB (L > R = positif → mix penché à gauche)
  const balanceLR = (rmsL != null && rmsR != null) ? +(rmsL - rmsR).toFixed(2) : null;
  // Mid/Side ratio : si on a la corrélation, on estime la part de side.
  // Approx : S²/(M²+S²) ≈ (1-corr)/2 quand L et R ont même énergie.
  // Plus la valeur est haute, plus le mix est large/diffus ; basse = central.
  const midSideRatio = (correlation != null)
    ? +Math.max(0, Math.min(1, (1 - correlation) / 2)).toFixed(3)
    : null;
  return {
    rmsL, rmsR,
    correlation: correlation != null ? +correlation.toFixed(3) : null,
    balanceLR,
    midSideRatio,
  };
}

/**
 * ebur128 sur le mix mono (mid uniquement). Pan filter convertit en mono
 * en mixant L et R à 50/50 (équivalent broadcast standard). Le LUFS
 * résultant est ce que l'auditeur entendrait sur un téléphone, une enceinte
 * mono Bluetooth, ou un compatible mono. Comparé au LUFS stéréo, la
 * différence quantifie la perte (ou le gain rare) en mono compat.
 */
function measureMonoLufs(buffer) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', 'pipe:0',
      // pan=mono fait la moyenne L+R. Pour stéréo input → mono output.
      '-af', 'pan=mono|c0=0.5*c0+0.5*c1,ebur128=peak=true',
      '-f', 'null', '-',
    ];
    let proc;
    try { proc = spawn(ffmpegPath, args); }
    catch (e) { console.warn('[dsp.mono] spawn:', e.message); return resolve(null); }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
    proc.stdin.on('error', (e) => { if (e.code !== 'EPIPE') console.warn('[dsp.mono] stdin:', e.message); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); console.warn('[dsp.mono] proc:', e.message); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) return resolve(null);
      resolve(parseEbur128(stderr));
    });
    try { proc.stdin.write(buffer); proc.stdin.end(); }
    catch (e) { console.warn('[dsp.mono] write:', e.message); }
  });
}

module.exports = { measureMaster, measureStem, measureStereoField };
