// VERSIONS — Charte mastering de référence (FR + EN)
//
// Ce contenu sert de "base de connaissances" injectée dans le system
// prompt de l'endpoint /api/mastering-charter. Claude la lit, la croise
// avec le contexte du track (genre, BPM, LUFS, fiche d'analyse, verdict
// de sortie, écoute qualitative) + les chunks PureMix pertinents, puis
// génère une charte mastering personnalisée pour CE track.
//
// La version "longue" côté front (src/constants/masteringCharter.js)
// reste utilisée comme fallback si l'API tombe — c'est la même structure
// mais figée. Côté backend on garde une version condensée pour limiter
// les tokens en system prompt.

const REFERENCE_FR = `**CHARTE MASTERING DE RÉFÉRENCE — cibles par destination**

**Streaming (Spotify, Apple Music, Deezer, Tidal, YouTube Music, Amazon Music)**
- Cible : −14 LUFS intégré / −1 dBTP
- Un seul master couvre TOUTES les plateformes streaming. Spotify/Tidal/YouTube sortent tel quel ; Apple ne baisse que de ~1-2 dB (imperceptible) ; Deezer pareil.
- Genres dynamiques (jazz, classique, folk, ambient) → −16 à −18 LUFS OK, ça respire mieux.
- Genres compressés (trap, hyperpop, hard techno, drill) → −10 à −12 LUFS acceptable, Spotify rabote ~2 dB mais on reste dans l'esthétique du genre.
- Surtout pas de chasse au volume au-delà de −10 : la normalisation te punit.

**Réseaux sociaux (TikTok, Instagram Reels, YouTube Shorts)**
- Cible : −14 à −10 LUFS / −1 dBTP
- Le master streaming (−14) suffit. Pousser à −10/−11 uniquement si TikTok est le canal principal (les algos sociaux récompensent les masters qui claquent dès la 1re seconde).
- Mono compatibility critique (~80% écoutes au speaker téléphone).
- Pas de moments calmes en intro de snippet.

**Club / DJ sets**
- Cible : −8 à −6 LUFS / −0.5 à −1 dBTP
- Si le track sort en streaming ET veut être jouable en club → DEUX MASTERS distincts. Un track à −14 LUFS dans une tracklist club à −7 LUFS sera fantôme.
- LRA serré 3-6 LU, sub mono ≤ 100-120 Hz strict, pas de dips d'énergie.
- Tendance 2024-26 : certains labels (techno mélodique, deep house) acceptent −10 LUFS.

**Vinyle (12" / 7")**
- Cible : −14 à −9 LUFS / −1 dBTP minimum
- Master vinyle dédié OBLIGATOIRE — jamais le master streaming brut. Si pas le matos, pre-master vinyle par le studio de gravure (50-150 €).
- Sub mono ≤ 100 Hz (≤ 200 Hz pour faces 22+ min), sibilances domptées (de-esser systématique), pas de limiteur brutal, pas de phase aiguë inversée sur les transitoires.

**CD audio**
- Cible : −10 à −9 LUFS / −1 dBTP
- Compromis pour vente physique. Pas de norme imposée, mais éviter au-delà de −9 (loudness war, fatigue d'écoute).

**Broadcast TV / Radio (EBU R128)**
- Cible : −23 LUFS Europe / −24 LKFS US (ATSC A/85) / −1 dBTP
- Norme imposée. Master plus chaud = rejet automatique par les contrôles de la chaîne.

**Cinéma (Dolby)**
- Dialogue calé à ~−27 LUFS référence. Salle calibrée, dynamique 20+ LU possible.
- Livrer master streaming le plus dynamique possible, le mixeur film fait le master final.

**RÈGLE DES 90% : un seul master à −14 LUFS / −1 dBTP couvre toutes les plateformes streaming + RS + Bandcamp. Master supplémentaire seulement si vinyle / club / CD / broadcast.**

**CHAÎNE MASTER BUS DE RÉFÉRENCE**
1. EQ correctif : HP 30 Hz, creux léger 200-300 Hz si boue, air 12-15 kHz
2. Bus compressor : ratio 2:1 ou 4:1, attaque 30-50 ms, release auto, 2-3 dB GR max
3. Saturation/coloration (optionnel) : Decapitator, Saturn 2, Black Box HG-2
4. Limiteur final : brickwall, ceiling −1 dBTP, oversampling x4+, pousser jusqu'à atteindre la cible LUFS

**SEUIL D'ALERTE :** plus de 6-7 dB de GR au limiteur pour atteindre −14 LUFS = mix trop dynamique ou pas maîtrisé. Le limiteur ne doit pas remplacer le compresseur de bus.

**MÉTHODE A/B :** ouvrir 2-3 références du genre dans la DAW, mesurer leur LUFS intégré (Youlean Loudness Meter), comparer en aveugle au volume perçu compensé.`;

const REFERENCE_EN = `**MASTERING TARGETS REFERENCE — by destination**

**Streaming (Spotify, Apple Music, Deezer, Tidal, YouTube Music, Amazon Music)**
- Target: −14 LUFS integrated / −1 dBTP
- A single master covers ALL streaming platforms. Spotify/Tidal/YouTube play as-is; Apple only reduces ~1-2 dB (inaudible); Deezer similar.
- Dynamic genres (jazz, classical, folk, ambient) → −16 to −18 LUFS OK, breathes better.
- Compressed genres (trap, hyperpop, hard techno, drill) → −10 to −12 LUFS acceptable, Spotify trims ~2 dB but stays in genre aesthetic.
- No volume chasing past −10: normalization will punish you.

**Social media (TikTok, Instagram Reels, YouTube Shorts)**
- Target: −14 to −10 LUFS / −1 dBTP
- Streaming master (−14) is enough. Push to −10/−11 only if TikTok is primary channel.
- Mono compatibility critical (~80% phone speaker).
- No quiet moments in snippet intro.

**Club / DJ sets**
- Target: −8 to −6 LUFS / −0.5 to −1 dBTP
- If track ships streaming AND wants club playability → TWO MASTERS. A −14 LUFS track in a −7 LUFS club tracklist sounds ghostly.
- Tight LRA 3-6 LU, strict sub mono ≤ 100-120 Hz, no energy dips.
- 2024-26 trend: some labels (melodic techno, deep house) accept −10 LUFS.

**Vinyl (12" / 7")**
- Target: −14 to −9 LUFS / −1 dBTP minimum
- Dedicated vinyl master REQUIRED — never raw streaming master. If no gear/skill, vinyl pre-master by cutting studio ($60-180).
- Sub mono ≤ 100 Hz (≤ 200 Hz for 22+ min sides), tamed sibilance, no brutal limiting, no inverted high-frequency phase on transients.

**Audio CD**
- Target: −10 to −9 LUFS / −1 dBTP
- Compromise for physical sale. No enforced norm; avoid past −9 (loudness war, listening fatigue).

**Broadcast TV / Radio (EBU R128)**
- Target: −23 LUFS Europe / −24 LKFS US (ATSC A/85) / −1 dBTP
- Enforced norm. Louder master = automatic rejection by chain controls.

**Cinema (Dolby)**
- Dialog anchored ~−27 LUFS reference. Calibrated room, 20+ LU dynamics possible.
- Hand off the most dynamic streaming master; film mixer does theatrical master.

**90% RULE: a single master at −14 LUFS / −1 dBTP covers all streaming + social + Bandcamp. Extra master only for vinyl / club / CD / broadcast.**

**MASTER BUS REFERENCE CHAIN**
1. Corrective EQ: HP 30 Hz, light dip 200-300 Hz if muddy, air 12-15 kHz
2. Bus compressor: 2:1 or 4:1 ratio, 30-50 ms attack, auto release, 2-3 dB GR max
3. Saturation/color (optional): Decapitator, Saturn 2, Black Box HG-2
4. Final limiter: brickwall, ceiling −1 dBTP, oversampling x4+, push until LUFS target

**WARNING THRESHOLD:** more than 6-7 dB GR on limiter to hit −14 LUFS = mix too dynamic or out of control. The limiter shouldn't replace the bus compressor.

**A/B METHOD:** open 2-3 genre references in the DAW, measure integrated LUFS (Youlean Loudness Meter), compare blind at gain-compensated perceived volume.`;

module.exports = {
  REFERENCE_FR,
  REFERENCE_EN,
  getReference: (locale = 'fr') =>
    String(locale).toLowerCase().slice(0, 2) === 'en' ? REFERENCE_EN : REFERENCE_FR,
};
