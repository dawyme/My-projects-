// Serverless handler entry point for Vercel (/api/* and /health)
require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const app = require('../backend/src/app');
module.exports = app;
