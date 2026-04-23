// lib/audio-storage.js
// Transcode un buffer audio en MP3 256k et l'uploade sur Supabase Storage (bucket "audio").
// Retourne le storage_path à enregistrer sur la version.

const { createClient } = require('@supabase/supabase-js');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
const { Readable, PassThrough } = require('stream');
const { randomUUID } = require('crypto');

ffmpeg.setFfmpegPath(ffmpegPath);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function transcodeToMp3(inputBuffer) {
  return new Promise((resolve, reject) => {
    const inputStream = Readable.from(inputBuffer);
    const output = new PassThrough();
    const chunks = [];
    output.on('data', (c) => chunks.push(c));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);

    ffmpeg(inputStream)
      .audioCodec('libmp3lame')
      .audioBitrate('256k')
      .format('mp3')
      .on('error', reject)
      .pipe(output);
  });
}

/**
 * Transcode (si besoin) puis upload sur le bucket Supabase "audio".
 * @param {Object} opts
 * @param {Buffer} opts.fileBuffer
 * @param {string} [opts.fileMime]
 * @param {string} opts.userId
 * @returns {Promise<string>} storage_path (ex: "{userId}/1713200000000-abcd1234.mp3")
 */
async function transcodeAndUpload({ fileBuffer, fileMime, userId }) {
  if (!userId) throw new Error('userId requis pour upload audio');
  if (!fileBuffer) throw new Error('fileBuffer requis');

  // Si déjà MP3, on skippe le transcodage
  const isMp3 = (fileMime || '').toLowerCase().includes('mpeg') || (fileMime || '').toLowerCase().includes('mp3');
  const mp3Buffer = isMp3 ? fileBuffer : await transcodeToMp3(fileBuffer);

  const path = `${userId}/${Date.now()}-${randomUUID().slice(0, 8)}.mp3`;

  const { error } = await supabase.storage
    .from('audio')
    .upload(path, mp3Buffer, {
      contentType: 'audio/mpeg',
      // Fichiers immuables (nom = UUID + timestamp) → on peut les mettre en cache
      // navigateur + CDN pour 1 an. Réduit drastiquement l'egress sur les re-lectures.
      cacheControl: '31536000',
      upsert: false,
    });

  if (error) throw new Error(`Supabase upload: ${error.message}`);
  return path;
}

module.exports = { transcodeAndUpload };
