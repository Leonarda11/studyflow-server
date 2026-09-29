import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
const router = Router();
router.use(requireAuth);
function normalizeHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.min(40, Math.round(hours * 10) / 10);
}
const OBLIGATION_TYPES = ['Zadatak', 'Ispit', 'Kolokvij', 'Projekt', 'Seminar', 'Ostalo'];
function normalizeType(value) {
  return OBLIGATION_TYPES.includes(value) ? value : 'Zadatak';
}
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `
      SELECT
        t.*,
        s.name AS subject_name,
        s.color AS subject_color
      FROM tasks t
      JOIN subjects s
        ON s.id = t.subject_id
      WHERE s.user_id = ?
      ${req.query.status === 'open' ? 'AND t.is_completed = 0' : ''}
      ORDER BY
        t.is_completed,
        t.due_date IS NULL,
        t.due_date
      `,
      [req.user.id]
    );

    res.json(rows);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      subject_id,
      title,
      description,
      due_date,
      priority = 'medium',
      estimated_hours,
      type
    } = req.body;

    if (!subject_id || !title?.trim()) {
      return res.status(400).json({
        message: 'Predmet i naziv zadatka su obavezni.'
      });
    }

    const [result] = await pool.query(
      `
      INSERT INTO tasks (
        subject_id,
        title,
        description,
        due_date,
        priority,
        estimated_hours,
        type
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM subjects
        WHERE id = ?
          AND user_id = ?
      )
      `,
      [
        subject_id,
        title.trim(),
        description?.trim() || null,
        due_date || null,
        ['low', 'medium', 'high'].includes(priority) ? priority : 'medium',
        normalizeHours(estimated_hours),
        normalizeType(type),
        subject_id,
        req.user.id
      ]
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
    const {
      title,
      description,
      due_date,
      is_completed,
      priority = 'medium',
      estimated_hours,
      type
    } = req.body;

    const [result] = await pool.query(
      `
      UPDATE tasks t
      JOIN subjects s
        ON s.id = t.subject_id
      SET
        t.title = ?,
        t.description = ?,
        t.due_date = ?,
        t.is_completed = ?,
        t.priority = ?,
        t.estimated_hours = ?,
        t.type = ?
      WHERE t.id = ?
        AND s.user_id = ?
      `,
      [
        title?.trim(),
        description?.trim() || null,
        due_date || null,
        Boolean(is_completed),
        ['low', 'medium', 'high'].includes(priority) ? priority : 'medium',
        normalizeHours(estimated_hours),
        normalizeType(type),
        req.params.id,
        req.user.id
      ]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'Zadatak nije pronađen.'
      });
    }

    res.json({
      message: 'Zadatak je ažuriran.'
    });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query(
      `
      DELETE t
      FROM tasks t
      JOIN subjects s
        ON s.id = t.subject_id
      WHERE t.id = ?
        AND s.user_id = ?
      `,
      [req.params.id, req.user.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'Zadatak nije pronađen.'
      });
    }

    res.status(204).end();
  })
);

export default router;
