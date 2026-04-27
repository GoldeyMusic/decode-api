const express = require('express');
const multer = require('multer');
const { generateFiche, formulatePerception, generateEvolution } = require('../lib/claude');
const { analyzeListening } = require('../lib/gemini');
const { retrievePureMixContext, formatContextForPrompt } = require('../lib/rag');
const { transcodeAndUpload } = require('../lib/audio-storage');
const { analyzeFile: fadrAnalyzeFile, extractFadrData } = require('../lib/fadr');

// Timeout dur cote pipeline pour ne pas bloquer la fiche si Fadr est lent ou KO.
// L analyse Fadr (upload + asset + stem polling) prend typiquement 30-90s ; au-dela
// on se passe des mesures pour ne pas degrader l UX. Mode degrade = fadrMetrics=null.
const FADR_TIMEOUT_MS = 90_000;
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

      let fileBuffer = null, fileMime = null, fileName = null;
      if (req.file) {
        fileBuffer = req.file.buffer;
        fileMime = req.file.mimetype || 'audio/mpeg';
        fileName = req.file.originalname || 'audio.mp3';
        console.log(`[analyze] ${req.file.originalname} (${Math.round(req.file.size / 1024)}KB)`);
      }

      // ── STAGE PARALLELE: Fadr (BPM, tonalite, LUFS, stems) ──
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
            durationSeconds, previousFiche, previousAnalysisResult, previousCompletions,
            locale,
            listening, pmContext, pmChunks, storagePromise, fadrPromise,
          },
        });
        return; // on ATTEND un POST /diagnose/:jobId pour reprendre
      }

      // ── PHASE B enchainee (skipIntent ou intention inline) ──
      await runDiagnosticPhase(jobId, {
        mode, daw, title, artist, version,
        durationSeconds, previousFiche, previousAnalysisResult, previousCompletions,
        locale,
        listening, pmContext, pmChunks,
        storagePromise, fadrPromise,
        intent: inlineIntent, // null si skip
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
    durationSeconds, previousFiche, previousAnalysisResult, previousCompletions,
    locale,
    listening, pmContext, pmChunks,
    storagePromise, fadrPromise,
    intent,
  } = ctx;

  // ── ATTENTE Fadr (avec timeout dur) ──
  // En conditions normales fadrPromise a fini pendant Gemini + RAG + perception.
  // Si Fadr est lent ou KO, on continue sans (mode degrade = fadrMetrics null).
  let fadrMetrics = null;
  if (fadrPromise) {
    fadrMetrics = await Promise.race([
      fadrPromise,
      new Promise((resolve) => setTimeout(() => {
        console.warn(`[analyze] fadr timeout ${FADR_TIMEOUT_MS / 1000}s — pipeline continues without metrics`);
        resolve(null);
      }, FADR_TIMEOUT_MS)),
    ]);
    if (fadrMetrics) {
      const cur = jobs.get(jobId) || {};
      jobs.set(jobId, { ...cur, stage: 'fadr_done', progress: 'Mesures objectives prêtes', pct: Math.max(cur.pct || 0, 75) });
    }
  }

  // ── STAGE 3: Claude fiche (listening + pmContext + intent + fadrMetrics) ──
  let fiche = null;
  try {
    fiche = await generateFiche(mode, daw, title || 'Titre inconnu', artist, listening, pmContext, previousFiche, intent || null, previousCompletions || null, fadrMetrics);
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
    fadrMetrics: fadrMetrics || null, // mesures objectives (BPM, tonalite, LUFS, stems) — null si Fadr KO/timeout
    pmSources: (pmChunks || []).map(c => ({
      source_file: c.source_file,
      category: c.category,
      similarity: c.similarity,
    })),
    ctx: undefined, // on purge pour eviter de garder le listening en memoire plus longtemps
  });
  console.log('[analyze] done');
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
