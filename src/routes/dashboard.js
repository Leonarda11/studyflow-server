import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
const router = Router();
router.use(requireAuth);
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [summary] = await pool.query(
      `
      SELECT
        (SELECT COUNT(*)
         FROM subjects
         WHERE user_id = ?) AS subject_count,

        (SELECT ROUND(AVG(g.value), 2)
         FROM grades g
         JOIN subjects s ON s.id = g.subject_id
         WHERE s.user_id = ?) AS average_grade,

        (SELECT COUNT(*)
         FROM tasks t
         JOIN subjects s ON s.id = t.subject_id
         WHERE s.user_id = ?
           AND t.is_completed = 0) AS open_task_count,

        (SELECT COALESCE(SUM(duration_minutes), 0)
         FROM study_sessions
         WHERE user_id = ?) AS total_study_minutes
      `,
      [req.user.id, req.user.id, req.user.id, req.user.id]
    );

    const [upcoming] = await pool.query(
      `
      SELECT
        t.*,
        s.name AS subject_name,
        s.color AS subject_color
      FROM tasks t
      JOIN subjects s
        ON s.id = t.subject_id
      WHERE s.user_id = ?
        AND t.is_completed = 0
        AND t.due_date IS NOT NULL
        AND t.due_date >= NOW()
      ORDER BY t.due_date
      LIMIT 5
      `,
      [req.user.id]
    );

    const [recent] = await pool.query(
      `
      SELECT
        t.*,
        s.name AS subject_name,
        s.color AS subject_color
      FROM tasks t
      JOIN subjects s
        ON s.id = t.subject_id
      WHERE s.user_id = ?
      ORDER BY t.created_at DESC
      LIMIT 5
      `,
      [req.user.id]
    );

    res.json({
      ...summary[0],
      upcoming,
      recent
    });
  })
);

export default router;
