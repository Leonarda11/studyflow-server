import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
const router = Router();
router.use(requireAuth);
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');
const ALLOWED_MIME_TYPES = new Set(['application/pdf']);
const PDF_MAGIC_BYTES = '%PDF-';
const sanitizeFilename = name =>
  name.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 180) || 'dokument.pdf';
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT m.*,s.name AS subject_name,s.color AS subject_color FROM materials m JOIN subjects s ON s.id=m.subject_id WHERE s.user_id=? ORDER BY m.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  })
);
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { subject_id, filename, mime_type, content_base64 } = req.body;
    if (!subject_id || !filename || !content_base64)
      return res.status(400).json({ message: 'Predmet i datoteka su obavezni.' });
    const content = Buffer.from(content_base64, 'base64');
    if (!content.length || content.length > 10485760)
      return res.status(400).json({ message: 'Datoteka mora biti manja od 10 MB.' });
    if (!ALLOWED_MIME_TYPES.has(mime_type))
      return res.status(400).json({ message: 'Podržane su samo PDF datoteke.' });
    if (content.subarray(0, 5).toString('latin1') !== PDF_MAGIC_BYTES)
      return res.status(400).json({ message: 'Datoteka nije valjan PDF.' });
    const [owned] = await pool.query('SELECT id FROM subjects WHERE id=? AND user_id=?', [
      subject_id,
      req.user.id
    ]);
    if (!owned.length) return res.status(404).json({ message: 'Predmet nije pronađen.' });
    await fs.mkdir(uploadsDir, { recursive: true });
    const storage_name = `${randomUUID()}${path.extname(filename).toLowerCase()}`;
    await fs.writeFile(path.join(uploadsDir, storage_name), content);
    const [result] = await pool.query(
      'INSERT INTO materials (subject_id,filename,storage_name,mime_type,size_bytes) VALUES (?,?,?,?,?)',
      [subject_id, sanitizeFilename(filename), storage_name, mime_type, content.length]
    );
    res.status(201).json({ id: result.insertId });
  })
);
router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT m.* FROM materials m JOIN subjects s ON s.id=m.subject_id WHERE m.id=? AND s.user_id=?`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Materijal nije pronađen.' });
    res.download(path.join(uploadsDir, rows[0].storage_name), rows[0].filename);
  })
);
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT m.* FROM materials m JOIN subjects s ON s.id=m.subject_id WHERE m.id=? AND s.user_id=?`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Materijal nije pronađen.' });
    await pool.query('DELETE FROM materials WHERE id=?', [req.params.id]);
    await fs.unlink(path.join(uploadsDir, rows[0].storage_name)).catch(() => {});
    res.status(204).end();
  })
);
export default router;
