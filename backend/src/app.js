const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.get('/health', (req, res) => res.json({status: 'healthy'}));
console.log('Production backend initialized');
