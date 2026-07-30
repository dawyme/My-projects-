const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const OUTBOX = path.join(__dirname, '..', '..', 'data', 'outbox.log');
let transporter = null;

function getTransporter() {
  if (transporter !== null) return transporter;
  if (!process.env.SMTP_HOST) { transporter = false; return false; }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_PORT) === '465',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

/**
 * Sends an email through SMTP when configured; otherwise appends it to a local
 * outbox file so nothing is silently lost in development.
 */
async function sendMail({ to, subject, text, html }) {
  const from = process.env.SMTP_FROM || 'CoolAir HVAC <no-reply@coolairhvac.com>';
  const t = getTransporter();
  if (!t) {
    const entry = `[${new Date().toISOString()}] TO=${to} SUBJECT=${subject}\n${text || html}\n---\n`;
    try { fs.appendFileSync(OUTBOX, entry); } catch (_) {}
    return { delivered: false, queued: true };
  }
  await t.sendMail({ from, to, subject, text, html });
  return { delivered: true };
}

const layout = (title, body) => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;margin:auto">
<div style="background:#0e7490;color:#fff;padding:18px 24px;border-radius:8px 8px 0 0"><h2 style="margin:0">${title}</h2></div>
<div style="border:1px solid #e2e8f0;border-top:0;padding:24px;border-radius:0 0 8px 8px;color:#0f172a;line-height:1.6">${body}</div></div>`;

const statusLabels = {
  PENDING: 'received and pending confirmation',
  CONFIRMED: 'confirmed',
  IN_PROGRESS: 'now in progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

async function sendBookingStatusEmail(booking, customer) {
  const when = new Date(booking.scheduledAt).toLocaleString();
  return sendMail({
    to: customer.email,
    subject: `Booking ${booking.reference} — ${booking.status.replace('_', ' ')}`,
    text: `Hi ${customer.name}, your booking ${booking.reference} scheduled for ${when} is ${statusLabels[booking.status] || booking.status}.`,
    html: layout('Service Booking Update', `<p>Hi <strong>${customer.name}</strong>,</p>
      <p>Your booking <strong>${booking.reference}</strong> scheduled for <strong>${when}</strong> is ${statusLabels[booking.status] || booking.status}.</p>
      <p>Thank you for choosing CoolAir HVAC &amp; Refrigeration.</p>`),
  });
}

async function sendMessageReplyEmail(message, body) {
  return sendMail({
    to: message.email,
    subject: `Re: ${message.subject || 'Your enquiry'}`,
    text: body,
    html: layout('Reply from CoolAir HVAC', `<p>Hi <strong>${message.name}</strong>,</p>
      <p>${String(body).replace(/\n/g, '<br>')}</p>`),
  });
}

module.exports = { sendMail, sendBookingStatusEmail, sendMessageReplyEmail };
