const express = require('express');
const app = express();
app.use(express.json());
app.get('/api/status', (req, res) => res.json({status: 'ok'}));
app.listen(3001, () => console.log('Backend running on port 3001'));
