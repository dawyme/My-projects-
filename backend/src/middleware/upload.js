
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { badRequest } = require('../lib/errors');

const UPLOAD_DIR = process.env.VERCEL
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let sharp = null;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) return cb(badRequest('Unsupported image type'));
    cb(null, true);
  },
});

/**
 * Persists an uploaded buffer to /uploads, converting raster images to
 * optimized WebP (resized to max 1600px) when sharp is available.
 */
async function persistImage(file) {
  const id = crypto.randomBytes(10).toString('hex');
  if (sharp && file.mimetype !== 'image/svg+xml' && file.mimetype !== 'image/gif') {
    const name = `${id}.webp`;
    await sharp(file.buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(path.join(UPLOAD_DIR, name));
    return `/uploads/${name}`;
  }
  const ext = path.extname(file.originalname).toLowerCase() || '.img';
  const name = `${id}${ext.replace(/[^a-z0-9.]/g, '')}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
  return `/uploads/${name}`;
}

function removeImage(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const target = path.join(UPLOAD_DIR, path.basename(url));
  fs.promises.unlink(target).catch(() => {});
}

/**
 * Persists an uploaded image for the media library, converting rasters to
 * optimised WebP (1600px max) plus a 400px cover thumbnail and returning the
 * full metadata so the Media Manager can record dimensions and file size.
 */
async function persistMedia(file, { folder = '/' } = {}) {
  const id = crypto.randomBytes(10).toString('hex');
  const base = { filename: file.originalname, mimeType: file.mimetype, size: file.size, folder };
  if (sharp && file.mimetype !== 'image/svg+xml' && file.mimetype !== 'image/gif') {
    const meta = await sharp(file.buffer).rotate().metadata();
    const name = `${id}.webp`;
    await sharp(file.buffer).rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(path.join(UPLOAD_DIR, name));
    const thumbName = `${id}-thumb.webp`;
    await sharp(file.buffer).rotate()
      .resize({ width: 400, height: 400, fit: 'cover' })
      .webp({ quality: 75 })
      .toFile(path.join(UPLOAD_DIR, thumbName));
    return { ...base, url: `/uploads/${name}`, thumbUrl: `/uploads/${thumbName}`, width: meta.width || null, height: meta.height || null };
  }
  const ext = path.extname(file.originalname).toLowerCase() || '.img';
  const name = `${id}${ext.replace(/[^a-z0-9.]/g, '')}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
  return { ...base, url: `/uploads/${name}`, thumbUrl: null, width: null, height: null };
}

module.exports = { upload, persistImage, removeImage, persistMedia, UPLOAD_DIR };
