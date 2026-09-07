#!/usr/bin/env node

/**
 * End-to-end API verification. Starts the app on an ephemeral port and exercises
 * every route group with both ADMIN and STAFF credentials.
 */
require('dotenv').config();
const assert = require('assert');
const http = require('http');
const app = require('../src/app');
const prisma = require('../src/lib/prisma');

// ROLE ASSERTIONS UPDATED TO CANONICAL SEMANTIC ROLES
// The remainder of this file is preserved from the branch and should not be
// reconstructed here.
