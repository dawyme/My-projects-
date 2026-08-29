import { renderRecords } from './records.js';
export async function render(view) { await renderRecords(view, { title: 'Service History', description: 'Historical service activity for customer equipment and jobs.', endpoint: '/service-history', empty: 'No service history records found.', columns: [
  { label: 'Date', keys: ['serviceDate','createdAt','date'] }, { label: 'Customer', keys: ['customer.name','customerName'] }, { label: 'Equipment', keys: ['equipment.name','equipmentName'] }, { label: 'Status', keys: ['status'] }
] }); }
