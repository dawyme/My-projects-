import { renderRecords } from './records.js';
export async function render(view) { await renderRecords(view, { title: 'Invoices', description: 'Track customer invoices, balances and payment status.', endpoint: '/invoices', empty: 'No invoices found.', columns: [
  { label: 'Invoice', keys: ['number','invoiceNumber','id'] }, { label: 'Customer', keys: ['customer.name','customerName'] }, { label: 'Total', keys: ['total','amount','grandTotal'] }, { label: 'Status', keys: ['status','paymentStatus'] }
] }); }
