#!/usr/bin/env node
/** Regression coverage for role-specific dashboard entry points. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const loginPage = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
const adminPage = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
const apiClient = fs.readFileSync(path.join(root, 'admin/js/api.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'backend/src/app.js'), 'utf8');

const requiredShells = [
  ['superadmin', 'SUPER_ADMIN'],
  ['tenant', 'TENANT_ADMIN'],
  ['technician', 'TECHNICIAN'],
  ['customer', 'CUSTOMER'],
];

for (const [dir, role] of requiredShells) {
  const shell = path.join(root, dir, 'index.html');
  assert(fs.existsSync(shell), `${role} must have its own dashboard shell at /${dir}/`);
  const source = fs.readFileSync(shell, 'utf8');
  assert(source.includes(`requiredRole = '${role}'`), `${role} shell must enforce its own role`);
  assert(source.includes("import { requireRole"), `${role} shell must use the role-specific auth guard`);
}

const expectedDestinations = {
  SUPER_ADMIN: '/superadmin/',
  TENANT_ADMIN: '/tenant/',
  TECHNICIAN: '/technician/',
  CUSTOMER: '/customer/',
  ADMIN: '/admin/',
  STAFF: '/admin/',
};
for (const [role, destination] of Object.entries(expectedDestinations)) {
  assert(loginPage.includes(`user?.role === '${role}'`), `Login must recognize ${role}`);
  assert(loginPage.includes(destination), `${role} must route to ${destination}`);
}

assert(adminPage.includes("user.role !== 'ADMIN' && user.role !== 'STAFF'"), 'Admin shell must reject non-admin/staff roles');
assert(adminPage.includes("../superadmin/"), 'Admin shell must redirect Super Admin out of the Admin Dashboard');
assert(adminPage.includes("../technician/"), 'Admin shell must redirect Technician out of the Admin Dashboard');
assert(adminPage.includes("../customer/"), 'Admin shell must redirect Customer out of the Admin Dashboard');
assert(apiClient.includes("location.href = '/login.html'"), 'Shared API client must use the absolute public login path');
assert(app.includes("app.use('/api/technician-portal', require('./routes/technician-portal'))"), 'Technician portal API must be mounted');
assert(app.includes("app.use('/api/customer-portal', require('./routes/customer-portal'))"), 'Customer portal API must be mounted');

for (const [route, role] of [['technician-portal.js','TECHNICIAN'],['customer-portal.js','CUSTOMER']]) {
  const source = fs.readFileSync(path.join(root, 'backend/src/routes', route), 'utf8');
  assert(source.includes(`authorize('${role}')`), `${role} portal API must enforce its role server-side`);
}

console.log('Role dashboard separation regression tests passed.');
