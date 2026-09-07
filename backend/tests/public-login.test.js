#!/usr/bin/env node
/** Regression coverage for the public application login path. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const loginPage = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

const loginRewrite = (vercel.rewrites || []).find((r) => r.source === '/login');
assert(loginRewrite, 'Vercel must expose /login');
assert.strictEqual(loginRewrite.destination, '/login.html', '/login must resolve to the public login page');

assert(loginPage.includes("import { auth, store, ApiError } from '/admin/js/api.js';"), 'Login page must reuse the existing auth client');
assert(loginPage.includes('await auth.login(email, password);'), 'Login page must call the existing login API');
assert(loginPage.includes('await auth.me();'), 'Login page must verify the authenticated session');
assert(loginPage.includes('location.replace(destination(user));'), 'Login page must redirect after authentication');
assert(loginPage.includes("!value.startsWith('//')"), 'Login next parameter must reject protocol-relative open redirects');
assert(!loginPage.includes('admin@ndsairconditioning.com'), 'Public login page must not expose demo credentials');
assert(!loginPage.includes('Admin@12345'), 'Public login page must not expose demo passwords');

console.log('Public login path regression tests passed.');

assert(loginPage.includes("user?.role === 'SUPER_ADMIN'"), 'SUPER_ADMIN must have a dedicated platform dashboard destination');
assert(loginPage.includes("return '/superadmin/'"), 'SUPER_ADMIN must route to the dedicated Super Admin dashboard');
assert(loginPage.includes("user?.role === 'TENANT_ADMIN'"), 'TENANT_ADMIN must have role-aware routing');
assert(loginPage.includes("user?.role === 'CUSTOMER'"), 'CUSTOMER must have role-aware routing');
assert(loginPage.includes("user?.role === 'TECHNICIAN'"), 'TECHNICIAN must have role-aware routing');
assert(loginPage.includes("user?.role === 'ADMIN'"), 'ADMIN must have role-aware routing');
assert(loginPage.includes("user?.role === 'STAFF'"), 'STAFF must have role-aware routing');
