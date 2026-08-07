// Production email service structure — requires: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
const { sendMail } = require('../lib/mailer');

async function sendEstimateEmail(estimate, customer) {
  return sendMail({
    to: customer.email,
    subject: `Estimate ${estimate.reference}`,
    text: `Estimate for ${customer.name}: $${estimate.total}`,
    html: `<p>Estimate <strong>${estimate.reference}</strong> total: $${estimate.total}</p>`,
  });
}

async function sendInvoiceEmail(invoice, customer) {
  return sendMail({
    to: customer.email,
    subject: `Invoice ${invoice.reference}`,
    text: `Invoice ${invoice.reference} due $${invoice.total}`,
    html: `<p>Invoice <strong>${invoice.reference}</strong>: $${invoice.total}</p>`,
  });
}

module.exports = { sendEstimateEmail, sendInvoiceEmail };
