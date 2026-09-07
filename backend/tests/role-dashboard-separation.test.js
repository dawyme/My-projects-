#!/usr/bin/env node
/** Regression coverage for role-specific dashboard entry points. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const loginPage = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
const adminPage = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');

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
  assert(source.includes("import { requireRole } from '../role-auth.js';"), `${role} shell must use role-specific auth guard`);
}

const expectedDestinations = {
  SUPER_ADMIN: '/superadmin/',
  TENANT_ADMIN: '/tenant/',
  TECHNICIAN: '/technician/',
  CUSTOMER: '/customer/',
};
for (const [role, destination] of Object.entries(expectedDestinations)) {
  assert(loginPage.includes(`user?.role === '${role}'`), `Login must recognize ${role}`);
  assert(loginPage.includes(destination), `${role} must route to ${destination}`);
}
assert(loginPage.includes("user?.role === 'ADMIN'"), 'Login must recognize ADMIN separately');
assert(loginPage.includes("user?.role === 'STAFF'"), 'Login must recognize STAFF separately');
assert(loginPage.includes("user?.role === 'TECHNICIAN'"), 'Login must recognize TECHNICIAN separately');

assert(adminPage.includes("user.role !== 'ADMIN' && user.role !== 'STAFF'"), 'Admin shell must reject non-admin/staff roles');
assert(adminPage.includes("location.replace('../login.html')"), 'Admin shell must redirect rejected roles through public login');

console.log('Role dashboard separation regression tests passed.');
