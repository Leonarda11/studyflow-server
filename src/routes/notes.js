import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
const router = Router();
router.use(requireAuth);
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `
      SELECT
        n.*,
        s.name AS subject_name,
        s.color AS subject_color
      FROM notes n
      JOIN subjects s
        ON s.id = n.subject_id
      WHERE s.user_id = ?
      ORDER BY n.updated_at DESC
      `,
      [req.user.id]
    );

    res.json(rows);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { subject_id, title, content } = req.body;

    if (!subject_id || !title?.trim() || !content?.trim()) {
      return res.status(400).json({
        message: 'Predmet, naslov i sadržaj su obavezni.'
      });
    }

    const [result] = await pool.query(
      `
      INSERT INTO notes (
        subject_id,
        title,
        content
      )
      SELECT ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM subjects
        WHERE id = ?
          AND user_id = ?
      )
      `,
      [subject_id, title.trim(), content.trim(), subject_id, req.user.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'Predmet nije pronađen.'
      });
    }

    res.status(201).json({
      id: result.insertId
    });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { title, content } = req.body;

    const [result] = await pool.query(
      `
      UPDATE notes n
      JOIN subjects s
        ON s.id = n.subject_id
      SET
        n.title = ?,
        n.content = ?
      WHERE n.id = ?
        AND s.user_id = ?
      `,
      [title?.trim(), content?.trim(), req.params.id, req.user.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'Bilješka nije pronađena.'
      });
    }

    res.json({
      message: 'Bilješka je ažurirana.'
    });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query(
      `
      DELETE n
      FROM notes n
      JOIN subjects s
        ON s.id = n.subject_id
      WHERE n.id = ?
        AND s.user_id = ?
      `,
      [req.params.id, req.user.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'Bilješka nije pronađena.'
      });
    }

    res.status(204).end();
  })
);

export default router;
