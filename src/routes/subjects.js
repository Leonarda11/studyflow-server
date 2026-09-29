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
        s.*,
        COUNT(DISTINCT g.id) AS grade_count,
        ROUND(AVG(g.value), 2) AS average_grade
      FROM subjects s
      LEFT JOIN grades g
        ON g.subject_id = s.id
      WHERE s.user_id = ?
      GROUP BY s.id
      ORDER BY s.name
      `,
      [req.user.id]
    );

    res.json(rows);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, code, color = '#4f46e5', semester = 1, ects = 0 } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        message: 'Naziv predmeta je obavezan.'
      });
    }

    const [result] = await pool.query(
      `
      INSERT INTO subjects (
        user_id,
        name,
        code,
        color,
        semester,
        ects
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        req.user.id,
        name.trim(),
        code?.trim() || null,
        color,
        Math.max(1, Math.min(12, Number(semester) || 1)),
        Math.max(0, Number(ects) || 0)
      ]
    );

    res.status(201).json({
      id: result.insertId,
      name: name.trim(),
      code: code?.trim() || null,
      color,
      semester: Math.max(1, Math.min(12, Number(semester) || 1)),
      ects: Math.max(0, Number(ects) || 0)
    });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { name, code, color, semester = 1, ects = 0 } = req.body;

    const [result] = await pool.query(
      `
      UPDATE subjects
      SET
        name = ?,
        code = ?,
        color = ?,
        semester = ?,
        ects = ?
      WHERE id = ?
        AND user_id = ?
      `,
      [
        name?.trim(),
        code?.trim() || null,
        color,
        Math.max(1, Math.min(12, Number(semester) || 1)),
        Math.max(0, Number(ects) || 0),
        req.params.id,
        req.user.id
      ]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'Predmet nije pronađen.'
      });
    }

    res.json({
      message: 'Predmet je ažuriran.'
    });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query(
      `
      DELETE FROM subjects
      WHERE id = ?
        AND user_id = ?
      `,
      [req.params.id, req.user.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'Predmet nije pronađen.'
      });
    }

    res.status(204).end();
  })
);

export default router;
