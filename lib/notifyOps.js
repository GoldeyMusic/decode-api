/**
 * lib/notifyOps.js — notif email ops à chaque event Stripe métier.
 *
 * Envoi via Resend (fetch natif Node 20, pas de dépendance npm ajoutée).
 *
 * Variables d'env :
 *   RESEND_API_KEY   — clé API Resend (obligatoire en prod, sinon no-op)
 *   OPS_NOTIFY_EMAIL — destinataire (default: contact@versions.studio)
 *   RESEND_FROM      — expéditeur (default: 'Versions ops <onboarding@resend.dev>')
 *                      Tant que versions.studio n'est pas vérifié dans Resend,
 *                      onboarding@resend.dev marche sans toucher aux DNS.
 *
 * Si RESEND_API_KEY est absent : no-op silencieux (warn dans logs). On NE casse
 * PAS le webhook Stripe pour un email raté — le crédit/log a déjà été appliqué
 * de façon idempotente avant l'appel notif.
 *
 * Toutes les erreurs réseau/Resend sont catchées ici : l'appelant peut faire
 * `await notifyOps(...)` sans try/catch supplémentaire.
 */

const RESEND_FROM = process.env.RESEND_FROM || 'Versions ops <onboarding@resend.dev>';
const OPS_TO = process.env.OPS_NOTIFY_EMAIL || 'contact@versions.studio';

async function notifyOps({ subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[notifyOps] RESEND_API_KEY missing → email skipped:', subject);
    return;
  }
  // Timeout 8s pour ne pas manger toute la fenêtre Stripe (30s).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [OPS_TO],
        subject,
        html: html || `<pre>${escapeHtml(text || '')}</pre>`,
        text: text || subject,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[notifyOps] resend failed:', res.status, body);
    }
  } catch (e) {
    console.error('[notifyOps] threw:', e.message);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Lien direct vers une ressource dans le dashboard Stripe.
// Stripe utilise /test/... pour les comptes en mode test, et /... en live.
// `livemode` est inclus dans chaque event Stripe (event.livemode === true en prod).
function stripeUrl({ livemode, kind, id }) {
  if (!id) return null;
  const base = livemode ? 'https://dashboard.stripe.com' : 'https://dashboard.stripe.com/test';
  // kind : 'customers' | 'payments' | 'invoices' | 'subscriptions'
  return `${base}/${kind}/${id}`;
}

// Render un email HTML simple, lisible sur mobile (Gmail).
// rows = [{ label, value, link? }]
function renderOpsEmail({ title, intro, rows, footerLink }) {
  const rowsHtml = (rows || [])
    .filter((r) => r && r.value !== null && r.value !== undefined && r.value !== '')
    .map((r) => {
      const v = r.link
        ? `<a href="${escapeHtml(r.link)}" style="color:#0070f3;text-decoration:none">${escapeHtml(String(r.value))}</a>`
        : escapeHtml(String(r.value));
      return `<tr><td style="padding:6px 14px;color:#666;font-size:13px;white-space:nowrap">${escapeHtml(r.label)}</td><td style="padding:6px 14px;font-size:14px;font-weight:500">${v}</td></tr>`;
    })
    .join('');
  const footer = footerLink
    ? `<p style="margin:24px 0 0;font-size:13px"><a href="${escapeHtml(footerLink)}" style="color:#0070f3;text-decoration:none">→ Ouvrir dans le dashboard Stripe</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fafafa;margin:0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eaeaea;border-radius:10px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #f0f0f0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#888;margin-bottom:6px">Versions · ops</div>
      <div style="font-size:18px;font-weight:600;color:#111">${escapeHtml(title)}</div>
      ${intro ? `<div style="margin-top:8px;font-size:14px;color:#444">${escapeHtml(intro)}</div>` : ''}
    </div>
    <table style="width:100%;border-collapse:collapse;margin:8px 0">${rowsHtml}</table>
    <div style="padding:0 24px 20px">${footer}</div>
  </div>
</body></html>`;
}

module.exports = { notifyOps, renderOpsEmail, stripeUrl };
