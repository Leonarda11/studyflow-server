import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
const router = Router();
router.use(requireAuth);
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [priority] = await pool.query(
      `SELECT priority, COUNT(*) AS total FROM tasks t JOIN subjects s ON s.id=t.subject_id WHERE s.user_id=? GROUP BY priority`,
      [req.user.id]
    );
    const [subjects] = await pool.query(
      `SELECT s.id,s.name,s.color,COUNT(t.id) AS total_tasks,SUM(CASE WHEN t.is_completed=1 THEN 1 ELSE 0 END) AS completed_tasks FROM subjects s LEFT JOIN tasks t ON t.subject_id=s.id WHERE s.user_id=? GROUP BY s.id ORDER BY s.name`,
      [req.user.id]
    );
    res.json({ priority, subjects });
  })
);
export default router;
