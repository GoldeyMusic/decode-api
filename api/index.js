/**
 * api/index.js — point d'entrée serverless Vercel.
 *
 * Vercel détecte les fichiers `api/*.js` sans préfixe `_` comme des
 * serverless functions. Ce fichier est le SEUL exposé : il réexporte
 * l'app Express complète depuis server.js.
 *
 * Tous les autres fichiers de routes vivent en api/_X.js (préfixe
 * underscore = ignoré par le routeur Vercel) et sont importés
 * normalement depuis server.js comme routers Express.
 *
 * Le `vercel.json` rewrite tous les `/api/*` vers ce fichier, donc
 * l'app Express reçoit la requête avec son URL d'origine et route
 * vers le bon handler interne (ex. /api/billing/health).
 *
 * En local (`npm start`), server.js fait `app.listen(PORT)` et ce
 * fichier-ci n'est pas utilisé. Conditionné par process.env.VERCEL.
 */

module.exports = require('../server');
