/**
 * Send email through Resend. The API key is supplied by the production
 * environment; no email provider or form service is used by the website.
 */
async function sendMail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');

  const from = process.env.RESEND_FROM || 'N&D’S Air Conditioning & Refrigeration Services <no-reply@ndsairconditioning.com>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text, html }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.message || payload?.error || `Resend request failed with HTTP ${response.status}`;
    throw new Error(String(message));
  }

  return { delivered: true, id: payload?.id };
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
    subject: `Booking ${booking.reference} â ${booking.status.replace('_', ' ')}`,
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
