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


async function sendTransactional({ to, subject, text, html }) {
  if (!to) return { delivered: false, skipped: true };
  const key = process.env.RESEND_API_KEY;
  if (key) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "N&D's <onboarding@resend.dev>",
        to: [to], subject, html: html || `<p>${String(text || '').replace(/\n/g, '<br>')}</p>`,
      }),
    });
    if (!response.ok) throw new Error(`Resend email failed: ${response.status}`);
    return { delivered: true, provider: 'resend', data: await response.json() };
  }
  return sendMail({ to, subject, text, html });
}

async function sendPublicBookingEmails(booking, customer, serviceName) {
  const businessEmail = process.env.BUSINESS_NOTIFICATION_EMAIL || 'ndsairconditioning@gmail.com';
  const when = new Date(booking.scheduledAt).toLocaleString();
  const details = [
    `Customer: ${customer.name}`,
    `Phone: ${customer.phone || 'Not provided'}`,
    `Email: ${customer.email && !customer.email.endsWith('@invalid.local') ? customer.email : 'Not provided'}`,
    `Service Type: ${serviceName}`,
    `Preferred date/time: ${when}`,
    `Address: ${booking.address || 'Not provided'}`,
    `Priority: ${booking.priority}`,
    `Reference: ${booking.reference}`,
    `Details: ${booking.description || 'None'}`,
  ].join('\n');
  await sendTransactional({
    to: businessEmail,
    subject: `New Service Booking — ${booking.reference} — ${serviceName}`,
    text: details,
    html: layout('New Service Booking', `<p><strong>Reference:</strong> ${booking.reference}</p><p><strong>Customer:</strong> ${customer.name}</p><p><strong>Phone:</strong> ${customer.phone || 'Not provided'}</p><p><strong>Email:</strong> ${customer.email && !customer.email.endsWith('@invalid.local') ? customer.email : 'Not provided'}</p><p><strong>Service Type:</strong> ${serviceName}</p><p><strong>Preferred date/time:</strong> ${when}</p><p><strong>Address:</strong> ${booking.address || 'Not provided'}</p><p><strong>Priority:</strong> ${booking.priority}</p><p><strong>Details:</strong> ${(booking.description || 'None').replace(/\n/g, '<br>')}</p>`),
  });
  if (customer.email && !customer.email.endsWith('@invalid.local')) {
    await sendTransactional({
      to: customer.email,
      subject: `N&D's Booking Request Received — ${booking.reference}`,
      text: `Hi ${customer.name},\n\nWe received your ${serviceName} booking request. Reference: ${booking.reference}. We will contact you to confirm the appointment.`,
      html: layout("N&D's Booking Request Received", `<p>Hi <strong>${customer.name}</strong>,</p><p>We received your <strong>${serviceName}</strong> booking request.</p><p><strong>Reference:</strong> ${booking.reference}</p><p>We will contact you to confirm the appointment.</p>`),
    });
  }
}

async function sendPublicContactEmails(message, serviceType) {
  const businessEmail = process.env.BUSINESS_NOTIFICATION_EMAIL || 'ndsairconditioning@gmail.com';
  const body = String(message.body || '');
  await sendTransactional({
    to: businessEmail,
    subject: `New Website Message — ${serviceType}`,
    text: `Name: ${message.name}\nPhone: ${message.phone || 'Not provided'}\nEmail: ${message.email && !message.email.endsWith('@invalid.local') ? message.email : 'Not provided'}\nService Type: ${serviceType}\n\n${body}`,
    html: layout('New Website Message', `<p><strong>Name:</strong> ${message.name}</p><p><strong>Phone:</strong> ${message.phone || 'Not provided'}</p><p><strong>Email:</strong> ${message.email && !message.email.endsWith('@invalid.local') ? message.email : 'Not provided'}</p><p><strong>Service Type:</strong> ${serviceType}</p><p>${body.replace(/\n/g, '<br>')}</p>`),
  });
  if (message.email && !message.email.endsWith('@invalid.local')) {
    await sendTransactional({
      to: message.email,
      subject: "N&D's — Message Received",
      text: `Hi ${message.name},\n\nWe received your message regarding ${serviceType}. Our team will get back to you shortly.`,
      html: layout("N&D's — Message Received", `<p>Hi <strong>${message.name}</strong>,</p><p>We received your message regarding <strong>${serviceType}</strong>.</p><p>Our team will get back to you shortly.</p>`),
    });
  }
}

module.exports = { sendMail, sendBookingStatusEmail, sendMessageReplyEmail, sendPublicBookingEmails, sendPublicContactEmails };
