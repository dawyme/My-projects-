import { renderRecords } from './records.js';
export async function render(view) { await renderRecords(view, { title: 'Estimates', description: 'Create and track customer estimates for service work.', endpoint: '/estimates', empty: 'No estimates found.', columns: [
  { label: 'Estimate', keys: ['number','estimateNumber','id'] }, { label: 'Customer', keys: ['customer.name','customerName'] }, { label: 'Total', keys: ['total','amount','grandTotal'] }, { label: 'Status', keys: ['status'] }
] }); }
