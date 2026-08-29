import { renderRecords } from './records.js';
export async function render(view) { await renderRecords(view, { title: 'Equipment', description: 'Customer equipment and installed assets managed by your service team.', endpoint: '/equipment', empty: 'No equipment records found.', columns: [
  { label: 'Equipment', keys: ['name','equipmentType','type','model'] }, { label: 'Customer', keys: ['customer.name','customerName'] }, { label: 'Serial / ID', keys: ['serialNumber','id'] }, { label: 'Status', keys: ['status','condition'] }
] }); }
