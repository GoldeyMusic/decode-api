// VERSIONS — Module RAG : recupere les extraits PureMix les plus pertinents
// pour l'ecoute Gemini actuelle, pour les passer en contexte a Claude.

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const EMBED_MODEL = 'text-embedding-3-small';
const DEFAULT_MATCH_COUNT = 6;
const DEFAULT_MIN_SIMILARITY = 0.25;

let _openai = null;
let _supabase = null;

function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[rag] OPENAI_API_KEY manquante');
    return null;
  }
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    console.warn('[rag] SUPABASE_URL/SUPABASE_ANON_KEY manquantes');
    return null;
  }
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

// Construit une requete concatenee a partir de l'ecoute Gemini.
// On prend ce qui decrit le plus concretement le morceau et les problemes.
function buildQueryFromListening(listening) {
  if (!listening) return '';
  const parts = [];
  if (listening.impression) parts.push(listening.impression);
  if (Array.isArray(listening.points_forts)) parts.push(listening.points_forts.join(' . '));
  if (Array.isArray(listening.a_travailler)) parts.push(listening.a_travailler.join(' . '));
  if (Array.isArray(listening.signatures)) parts.push(listening.signatures.join(' . '));
  if (listening.espace) parts.push(listening.espace);
  if (listening.dynamique) parts.push(listening.dynamique);
  if (listening.couleur) parts.push(listening.couleur);
  if (listening.mood) parts.push('mood: ' + listening.mood);
  return parts.filter(Boolean).join(' ');
}

async function retrievePureMixContext(listening, opts = {}) {
  const matchCount = opts.matchCount || DEFAULT_MATCH_COUNT;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  const query = buildQueryFromListening(listening);
  if (!query || query.length < 20) {
    console.log('[rag] requete vide/trop courte, skip RAG');
    return [];
  }

  const openai = getOpenAI();
  const supabase = getSupabase();
  if (!openai || !supabase) {
    console.log('[rag] dependances indisponibles, skip RAG');
    return [];
  }

  try {
    const startEmbed = Date.now();
    const embedRes = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: query.slice(0, 8000), // safety cap
    });
    const queryEmbedding = embedRes.data[0].embedding;
    console.log(`[rag] query embedded in ${Date.now() - startEmbed}ms`);

    const startMatch = Date.now();
    const { data, error } = await supabase.rpc('match_puremix_chunks', {
      query_embedding: queryEmbedding,
      match_count: matchCount,
      min_similarity: minSimilarity,
    });
    if (error) {
      console.error('[rag] match error:', error.message);
      return [];
    }
    console.log(`[rag] matched ${data?.length || 0} chunks in ${Date.now() - startMatch}ms`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[rag] retrieval error:', err.message);
    return [];
  }
}

// Formate les chunks recus en bloc texte prete a etre injecte dans un prompt.
function formatContextForPrompt(chunks) {
  if (!chunks || !chunks.length) return '';
  const pieces = chunks.map((c, i) => {
    const src = c.source_file ? c.source_file.replace(/_EN\.txt$/, '').replace(/[-_]/g, ' ') : 'source';
    return `--- Extrait ${i + 1} (${c.category} - ${src}) ---\n${c.content}`;
  });
  return pieces.join('\n\n');
}

module.exports = { retrievePureMixContext, formatContextForPrompt };
