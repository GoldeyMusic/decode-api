const express = require('express');
const multer = require('multer');
const claudeLib = require('../lib/claude');
const { generateFiche, formulatePerception, generateEvolution } = claudeLib;
const geminiLib = require('../lib/gemini');
const { analyzeListening } = geminiLib;
const { retrievePureMixContext, formatContextForPrompt } = require('../lib/rag');
const { transcodeAndUpload } = require('../lib/audio-storage');
const { analyzeFile: fadrAnalyzeFile, extractFadrData, downloadStems: fadrDownloadStems } = require('../lib/fadr');
const { measureMaster: dspMeasureMaster, measureStem: dspMeasureStem, measureStereoField: dspMeasureStereoField } = require('../lib/dsp');
const { logAnalysisCost } = require('../lib/costTracker');

// Timeout dur cote pipeline pour ne pas bloquer la fiche si Fadr est lent ou KO.
// L analyse Fadr (upload + asset + stem polling) prend typiquement 30-90s ; au-dela
// on se passe des mesures pour ne pas degrader l UX. Mode degrade = fadrMetrics=null.
const FADR_TIMEOUT_MS = 90_000;
// DSP maison (ffmpeg ebur128) — beaucoup plus rapide que Fadr (10-20s pour
// un titre de 4 min). On garde une marge confortable au cas ou un fichier
// long ou un container exotique demande plus de temps.
const DSP_TIMEOUT_MS = 60_000;
// Phase 3 (DSP_PLAN B.4) — mesures par stem (4 stems × ebur128 + 2 bandpass
// + Mid/Side + mono compat sur master). Sequentielles sur la latence du
// download Fadr (qui est deja inclus dans FADR_TIMEOUT_MS) puis ffmpeg
// ~5-10s par stem en parallele. On laisse 90s totaux pour absorber le
// download des 4 stems S3 et les 8-12 spawns ffmpeg simultanes.
const STEMS_TIMEOUT_MS = 90_000;
const STEREO_TIMEOUT_MS = 60_000;
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const jobs = new Map();
function makeJobId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

// Flow (pipeline en 2 phases) :
//   Phase A  — Gemini (ecoute) -> RAG PureMix -> Claude.formulatePerception -> job passe en 'awaiting_intent'
//              (transcodage MP3 + upload Supabase lances en parallele)
//   [attente de POST /diagnose/:jobId avec l intention de l utilisateur (ou skip)]
//   Phase B  — Claude.generateFiche(..., intent) -> job 'complete'
//
// Retro-compat : POST /start avec body field `skipIntent=true` enchaine les 2 phases
// comme avant (pratique pour tests curl ou pour le front tant qu il n expose pas l ecran intention).
router.post('/start', upload.single('file'), async (req, res) => {
  const jobId = makeJobId();
  jobs.set(jobId, { status: 'pending', progress: 'Démarrage…', pct: 0 });
  res.json({ jobId });

  // Reset les accumulators de tokens AVANT le pipeline (cost tracking).
  // Lus à la fin de runDiagnosticPhase via getUsage() pour insérer la
  // ligne analysis_cost_logs (cf. lib/costTracker.js).
  // Note : les accumulators sont module-scope, donc thread-safe seulement
  // si une seule analyse tourne à la fois. Le runtime Vercel garantit
  // ça (1 invocation = 1 process). À surveiller si on passe en worker pool.
  claudeLib.resetUsage();
  geminiLib.resetUsage();

  (async () => {
    try {
      const mode = req.body.mode, daw = req.body.daw;
      const title = req.body.title || (req.file ? req.file.originalname.replace(/\.[^/.]+$/, '') : '');
      const version = req.body.version || '';
      const artist = req.body.artist || '';
      const userId = req.body.userId || null;
      const skipIntent = req.body.skipIntent === 'true' || req.body.skipIntent === true;
      const durationSeconds = parseFloat(req.body.durationSeconds) || null;
      let previousFiche = null;
      try { previousFiche = req.body.previousFiche ? JSON.parse(req.body.previousFiche) : null; } catch {}
      // previousAnalysisResult : { fiche, listening } de la version precedente du meme titre.
      // Sert a generer le bandeau "evolution depuis V_n-1" (suivi inter-versions).
      // Si absent : pas d evolution generee, pipeline identique a avant.
      let previousAnalysisResult = null;
      try {
        previousAnalysisResult = req.body.previousAnalysisResult
          ? JSON.parse(req.body.previousAnalysisResult)
          : null;
      } catch {}
      // Ticket 4.2 — items coches "implementes" sur la version precedente.
      // Tableau d ids passe par le front depuis la table mix_note_completions.
      // Sert au verrou des sub-scores (advice-followed locking).
      let previousCompletions = null;
      try {
        const raw = req.body.previousCompletions;
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) previousCompletions = arr.filter((x) => typeof x === 'string');
        }
      } catch {}
      const locale = typeof req.body.locale === 'string' && req.body.locale.trim().length > 0
        ? req.body.locale.trim()
        : 'fr';
      // Intention inline (fournie avant analyse, ex: heritee du titre pour une V2+)
      const inlineIntent = typeof req.body.intent === 'string' && req.body.intent.trim().length > 0
        ? req.body.intent.trim()
        : null;
      // Genre musical : declare par l artiste a l upload (texte libre court)
      // ou flag "Choisir automatiquement" -> inference par Claude depuis l ecoute.
      const declaredGenre = typeof req.body.declaredGenre === 'string' && req.body.declaredGenre.trim().length > 0
        ? req.body.declaredGenre.trim().slice(0, 600)
        : null;
      const genreUnknown = req.body.genreUnknown === 'true' || req.body.genreUnknown === true;

      let fileBuffer = null, fileMime = null, fileName = null;
      if (req.file) {
        fileBuffer = req.file.buffer;
        fileMime = req.file.mimetype || 'audio/mpeg';
        fileName = req.file.originalname || 'audio.mp3';
        console.log(`[analyze] ${req.file.originalname} (${Math.round(req.file.size / 1024)}KB)`);
      }

      // ── STAGE PARALLELE: Fadr (BPM, tonalite, stems) ──
      // Lance des reception du fichier en parallele de Gemini, du RAG et de la formulation
      // perception. On l attend juste avant generateFiche (avec timeout pour ne pas
      // bloquer la fiche si Fadr est lent). Erreurs et timeout = mode degrade (null).
      let fadrPromise = null;
      if (fileBuffer) {
        const ext = (fileName.split('.').pop() || 'mp3').toLowerCase();
        const t0 = Date.now();
        fadrPromise = fadrAnalyzeFile(fileBuffer, fileName, ext, fileMime)
          .then((task) => {
            const data = extractFadrData(task);
            console.log(`[analyze] fadr done in ${((Date.now() - t0) / 1000).toFixed(1)}s — bpm:${data.bpm} key:${data.key} lufs:${data.lufs} stems:${(data.stems || []).length}`);
            return data;
          })
          .catch((err) => {
            console.error(`[analyze] fadr error after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, err.message);
            return null;
          });
      }

      // ── STAGE PARALLELE: DSP maison (LUFS, LRA, True peak) ──
      // Phase 2 du DSP_PLAN. Tournant via ffmpeg ebur128 (ITU-R BS.1770).
      // Beaucoup plus rapide que Fadr (10-20s typique) et sans cout API.
      // Mode degrade : null si ffmpeg KO ou timeout.
      let dspPromise = null;
      if (fileBuffer) {
        dspPromise = dspMeasureMaster(fileBuffer)
          .catch((err) => {
            console.error('[analyze] dsp measureMaster error:', err.message);
            return null;
          });
      }

      // ── STAGE PARALLELE: STEMS (Phase 3 / DSP_PLAN B.4) ──
      // Chaine apres Fadr (besoin de l'asset.stems pour les URLs signees).
      // Telecharge les buffers en RAM, mesure chaque stem (LUFS + bandpass
      // sibilantes/presence), puis jette les buffers. Mode degrade total :
      // null si Fadr KO, ou tableau partiel si certains stems KO.
      let stemsPromise = null;
      if (fadrPromise) {
        stemsPromise = fadrPromise.then(async (data) => {
          if (!data?.stems?.length) return null;
          // downloadStems accepte un faux asset { stems: [...] } puisqu'il
          // ne lit que asset.stems. Evite de propager le `task` complet.
          let downloaded = null;
          try {
            downloaded = await fadrDownloadStems({ stems: data.stems });
          } catch (err) {
            console.error('[analyze] stems download error:', err.message);
            return null;
          }
          if (!downloaded || !downloaded.length) return null;
          // Mesures paralleles, buffers jetes apres mesure.
          const measured = await Promise.all(downloaded.map(async (s) => {
            const m = await dspMeasureStem(s.buffer, s.stemType).catch((err) => {
              console.warn(`[analyze] stem ${s.stemType} measure error:`, err.message);
              return null;
            });
            return {
              name: s.name,
              stemType: s.stemType,
              sizeBytes: s.sizeBytes,
              ...(m || {}),
            };
          }));
          // On garde tous les stems telecharges meme si la mesure a echoue
          // (le front saura : sizeBytes != null + lufs == null = mesure ratee).
          return measured;
        }).catch((err) => {
          console.error('[analyze] stems chain error:', err.message);
          return null;
        });
      }

      // ── STAGE PARALLELE: STEREO FIELD (Phase 3 / DSP_PLAN B.3) ──
      // Mesure independante du Fadr — utilise le buffer master directement.
      // On chaine sur dspPromise pour reutiliser le LUFS stereo deja mesure
      // et eviter un troisieme spawn ebur128 redondant.
      let stereoPromise = null;
      if (fileBuffer) {
        stereoPromise = (dspPromise || Promise.resolve(null))
          .then((dspMaster) =>
            dspMeasureStereoField(fileBuffer, dspMaster?.lufs ?? null)
          )
          .catch((err) => {
            console.error('[analyze] stereo error:', err.message);
            return null;
          });
      }

      const meta = { title, artist, daw, mode, version };
      jobs.set(jobId, {
        status: 'pending', stage: 'started',
        progress: 'Préparation de l\'écoute…', pct: 10,
        meta,
      });

      // ── STAGE 1: Gemini listening ──────────────
      let listening = null;
      if (fileBuffer) {
        try {
          listening = await analyzeListening(fileBuffer, fileMime, title || '', artist || '', mode);
          console.log('[analyze] listening done');
        } catch (err) {
          console.error('[analyze] listening error:', err.message);
          listening = null;
        }
      }
      const cur1 = jobs.get(jobId) || {};
      jobs.set(jobId, {
        ...cur1,
        status: 'partial', stage: 'listening_done',
        progress: listening ? 'Écoute qualitative prête' : 'Écoute indisponible',
        pct: 55,
        listening: listening || null,
      });

      // ── STAGE PARALLÈLE: transcodage MP3 + upload Supabase ──
      // Lancé en parallèle du reste pour ne pas ajouter à la latence perçue.
      let storagePromise = null;
      if (fileBuffer && userId) {
        storagePromise = transcodeAndUpload({ fileBuffer, fileMime, userId })
          .then((path) => { console.log('[analyze] audio stored:', path); return path; })
          .catch((err) => { console.error('[analyze] storage error:', err.message); return null; });
      } else if (!userId) {
        console.warn('[analyze] no userId, skipping audio upload');
      }

      // ── STAGE 2: RAG PureMix context ───────────
      let pmChunks = [];
      if (listening) {
        try {
          pmChunks = await retrievePureMixContext(listening);
          console.log(`[analyze] rag: ${pmChunks.length} chunks retrieved`);
        } catch (err) {
          console.error('[analyze] rag error:', err.message);
          pmChunks = [];
        }
      }
      const pmContext = formatContextForPrompt(pmChunks);
      const cur15 = jobs.get(jobId) || {};
      jobs.set(jobId, {
        ...cur15,
        stage: 'rag_done',
        progress: 'Contexte PureMix prêt',
        pct: 65,
      });

      // ── PHASE A FINALE : perception formulée (optionnelle, activee seulement si
      //    on ne saute pas l etape intention et qu on n a PAS recu d intention inline) ──
      const shouldAwaitIntent = !skipIntent && !inlineIntent;

      if (shouldAwaitIntent) {
        let perception = null;
        try {
          perception = await formulatePerception(listening);
          console.log('[analyze] perception formulée');
        } catch (err) {
          console.error('[analyze] perception error:', err.message);
          perception = null; // on passe quand meme en awaiting_intent, le front saura gérer
        }

        // Stocke dans le job tout ce dont la Phase B aura besoin
        const curA = jobs.get(jobId) || {};
        jobs.set(jobId, {
          ...curA,
          status: 'awaiting_intent', stage: 'awaiting_intent',
          progress: 'En attente de ton intention artistique…',
          pct: 70,
          perception: perception || null,
          // Contexte de reprise pour /diagnose/:jobId
          ctx: {
            mode, daw, title, artist, version,
            userId,
            durationSeconds, previousFiche, previousAnalysisResult, previousCompletions,
            locale,
            listening, pmContext, pmChunks, storagePromise, fadrPromise, dspPromise,
            stemsPromise, stereoPromise,
            declaredGenre, genreUnknown,
          },
        });
        return; // on ATTEND un POST /diagnose/:jobId pour reprendre
      }

      // ── PHASE B enchainee (skipIntent ou intention inline) ──
      await runDiagnosticPhase(jobId, {
        mode, daw, title, artist, version,
        userId,
        durationSeconds, previousFiche, previousAnalysisResult, previousCompletions,
        locale,
        listening, pmContext, pmChunks,
        storagePromise, fadrPromise, dspPromise, stemsPromise, stereoPromise,
        intent: inlineIntent, // null si skip
        declaredGenre, genreUnknown,
      });
    } catch (err) {
      console.error('[analyze] error:', err.message);
      jobs.set(jobId, { status: 'error', error: err.message });
    }
  })();
});

// ─── POST /diagnose/:jobId — reprend un job en 'awaiting_intent' et execute la Phase B ───
// body: { intent: string|null }
// Si intent est vide/null, on lance le diagnostic en lecture neutre (equivalent skip).
router.post('/diagnose/:jobId', express.json(), (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'awaiting_intent' || !job.ctx) {
    return res.status(409).json({ error: 'Job not in awaiting_intent state', status: job.status });
  }

  const intent = typeof req.body?.intent === 'string' && req.body.intent.trim().length > 0
    ? req.body.intent.trim()
    : null;

  // Marquage immediat pour que le front voie la transition
  jobs.set(jobId, {
    ...job,
    status: 'pending', stage: 'diagnosing',
    progress: 'Diagnostic calibré en cours…',
    pct: 80,
  });
  res.json({ ok: true, jobId, intent_used: intent });

  // Execution en tache de fond (comme /start)
  (async () => {
    try {
      await runDiagnosticPhase(jobId, { ...job.ctx, intent });
    } catch (err) {
      console.error('[diagnose] error:', err.message);
      jobs.set(jobId, { ...(jobs.get(jobId) || {}), status: 'error', error: err.message });
    }
  })();
});

// Execute Claude.generateFiche + attend le transcodage + marque le job complete.
// Utilise par /start (skipIntent) et par /diagnose/:jobId.
async function runDiagnosticPhase(jobId, ctx) {
  const {
    mode, daw, title, artist,
    userId,
    durationSeconds, previousFiche, previousAnalysisResult, previousCompletions,
    locale,
    listening, pmContext, pmChunks,
    storagePromise, fadrPromise, dspPromise, stemsPromise, stereoPromise,
    intent,
    declaredGenre, genreUnknown,
  } = ctx;

  // ── ATTENTE Fadr + DSP en parallele (avec timeouts independants) ──
  // Les deux promesses sont independantes : Fadr (cloud, lent) et DSP maison
  // (ffmpeg local, rapide). On les attend en parallele pour ne pas serialiser.
  // Mode degrade : null si timeout/erreur, le pipeline continue.
  const awaitWithTimeout = (promise, ms, label) => {
    if (!promise) return Promise.resolve(null);
    let timeoutId = null;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        console.warn(`[analyze] ${label} timeout ${ms / 1000}s — pipeline continues without`);
        resolve(null);
      }, ms);
    });
    return Promise.race([promise, timeoutPromise]).then((v) => {
      if (timeoutId) clearTimeout(timeoutId);
      return v;
    });
  };

  const [fadrMetrics, dspMetrics, stemsMetrics, stereoMetrics] = await Promise.all([
    awaitWithTimeout(fadrPromise, FADR_TIMEOUT_MS, 'fadr'),
    awaitWithTimeout(dspPromise, DSP_TIMEOUT_MS, 'dsp'),
    awaitWithTimeout(stemsPromise, STEMS_TIMEOUT_MS, 'stems'),
    awaitWithTimeout(stereoPromise, STEREO_TIMEOUT_MS, 'stereo'),
  ]);

  if (fadrMetrics || dspMetrics || stemsMetrics || stereoMetrics) {
    const cur = jobs.get(jobId) || {};
    jobs.set(jobId, { ...cur, stage: 'measures_done', progress: 'Mesures objectives prêtes', pct: Math.max(cur.pct || 0, 75) });
  }

  // ── STAGE 3: Claude fiche (listening + pmContext + intent + mesures) ──
  // On fusionne fadr (BPM, tonalite, stems list), dsp master (LUFS, LRA,
  // truePeak), stems mesures (LUFS+bandes par stem) et stereo (corr, M/S,
  // mono compat) dans un objet "metrics" passe a Claude. Le LUFS DSP a la
  // priorite sur le LUFS Fadr (qui est souvent null de toute facon).
  const hasAnyMeasure = !!(fadrMetrics || dspMetrics || stemsMetrics || stereoMetrics);
  const mergedMetrics = hasAnyMeasure ? {
    ...(fadrMetrics || {}),
    ...(dspMetrics ? {
      lufs: dspMetrics.lufs ?? (fadrMetrics?.lufs ?? null),
      lra: dspMetrics.lra ?? null,
      truePeak: dspMetrics.truePeak ?? null,
    } : {}),
    // Phase 3 (DSP_PLAN B.4) — ajout des mesures par stem et du champ stereo.
    // Null si la mesure correspondante a echoue (mode degrade).
    stemsMeasured: stemsMetrics || null, // [{stemType, lufs, truePeak, energyBand_5_8kHz, energyBand_1_3kHz, ...}]
    stereo: stereoMetrics || null,        // {correlation, midSideRatio, balanceLR, monoCompat}
  } : null;

  let fiche = null;
  try {
    fiche = await generateFiche(mode, daw, title || 'Titre inconnu', artist, listening, pmContext, previousFiche, intent || null, previousCompletions || null, mergedMetrics, declaredGenre || null, !!genreUnknown);
    if (fiche && durationSeconds) fiche.duration_seconds = durationSeconds;
    console.log('[analyze] claude done — keys:', Object.keys(fiche || {}).join(', '));
  } catch (err) {
    console.error('[analyze] claude error:', err.message);
  }

  // ── STAGE 4 (optionnel): Claude evolution (suivi inter-versions) ──
  // Ne se declenche que si on a une analyse precedente complete (fiche +
  // listening) ET une nouvelle fiche/listening. Sinon : pas d evolution,
  // pipeline strictement identique a avant.
  let evolution = null;
  const canCompare =
    fiche && listening &&
    previousAnalysisResult &&
    previousAnalysisResult.fiche &&
    previousAnalysisResult.listening;
  if (canCompare) {
    try {
      evolution = await generateEvolution(
        { fiche: previousAnalysisResult.fiche, listening: previousAnalysisResult.listening },
        { fiche, listening },
        intent || previousAnalysisResult.intent_used || null,
        locale || 'fr',
      );
      if (evolution) console.log('[analyze] evolution done — dominante:', evolution.dominante);
      else console.log('[analyze] evolution skipped (null result)');
    } catch (err) {
      console.error('[analyze] evolution error:', err.message);
      evolution = null;
    }
  }

  // Attend la fin du transcodage/upload (peut avoir fini depuis longtemps)
  const storagePath = storagePromise ? await storagePromise : null;

  const cur = jobs.get(jobId) || {};
  jobs.set(jobId, {
    ...cur,
    status: 'complete', stage: 'all_done',
    progress: 'Terminé', pct: 100,
    fiche: fiche || null,
    listening: listening || null,
    evolution: evolution || null,
    storagePath: storagePath || null,
    intent_used: intent || null, // utile pour le front
    fadrMetrics: fadrMetrics || null, // BPM, tonalite, stems — null si Fadr KO
    dspMetrics: dspMetrics || null,   // LUFS, LRA, truePeak — null si ffmpeg KO
    // Phase 3 (DSP_PLAN B.4) — mesures par stem et champ stereo.
    stemsMetrics: stemsMetrics || null, // [{stemType, lufs, truePeak, energyBand_*, ...}] ou null
    stereoMetrics: stereoMetrics || null, // {correlation, midSideRatio, balanceLR, monoCompat} ou null
    pmSources: (pmChunks || []).map(c => ({
      source_file: c.source_file,
      category: c.category,
      similarity: c.similarity,
    })),
    ctx: undefined, // on purge pour eviter de garder le listening en memoire plus longtemps
  });
  console.log('[analyze] done');

  // ── COST TRACKING (analysis_cost_logs) ──
  // Insère la ligne de coût de cette analyse dans Supabase.
  // Lit les accumulators de tokens captés pendant le pipeline (gemini + claude)
  // et y ajoute les forfaits Fadr/infra (cf. lib/costTracker.js).
  // Try/catch isolé : une erreur DB ne doit JAMAIS casser une analyse réussie.
  try {
    await logAnalysisCost({
      userId: userId || null,
      jobId,
      audioDurationSec: durationSeconds || null,
      geminiUsage: geminiLib.getUsage(),
      claudeUsage: claudeLib.getUsage(),
      fadrCalled: !!fadrMetrics,
    });
  } catch (err) {
    console.error('[analyze] cost tracking error (non-fatal):', err.message);
  }
}

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  // On ne renvoie PAS `ctx` au front (trop lourd, contient listening + pmContext).
  const { ctx, ...publicJob } = job;
  res.json(publicJob);
  if (job.status === 'complete' || job.status === 'error') {
    setTimeout(() => jobs.delete(req.params.jobId), 60000);
  }
});


module.exports = router;
