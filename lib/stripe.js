/**
 * lib/stripe.js — initialisation paresseuse du SDK Stripe.
 *
 * On lazy-init pour éviter d'exiger STRIPE_SECRET_KEY au boot du
 * serveur tant que Stripe n'est pas branché en prod.
 */
let _stripe = null;

function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY missing — billing endpoints unavailable');
  }
  // eslint-disable-next-line global-require
  const Stripe = require('stripe');
  _stripe = new Stripe(key, {
    // Pas de pin sur apiVersion — on prend le défaut du SDK installé.
    appInfo: { name: 'Versions', version: '1.0.0' },
  });
  return _stripe;
}

module.exports = { getStripe };
