const express = require('express');
const asyncHandler = require('../lib/async');
const { protect } = require('../middleware/auth');
const { accessibleFeatures } = require('../lib/features');

const router = express.Router();
router.get('/access', protect, asyncHandler(async (req, res) => {
  const features = await accessibleFeatures(req.user);
  res.json({ success: true, data: features.map((feature) => ({ id: feature.id, key: feature.key, name: feature.name })) });
}));
module.exports = router;
