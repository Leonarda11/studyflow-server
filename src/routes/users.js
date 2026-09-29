import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
const router = Router();
router.use(requireAuth);
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `
      SELECT
        id,
        name,
        email,
        program,
        created_at
      FROM users
      WHERE id = ?
      `,
      [req.user.id]
    );

    res.json(rows[0]);
  })
);

router.get(
  '/me/settings',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT deadline_reminders, weekly_summary, study_streak FROM notification_settings WHERE user_id=?',
      [req.user.id]
    );
    res.json(rows[0] || { deadline_reminders: 1, weekly_summary: 1, study_streak: 0 });
  })
);

router.put(
  '/me/settings',
  asyncHandler(async (req, res) => {
    const { deadline_reminders, weekly_summary, study_streak } = req.body;
    await pool.query(
      'INSERT INTO notification_settings (user_id,deadline_reminders,weekly_summary,study_streak) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE deadline_reminders=VALUES(deadline_reminders),weekly_summary=VALUES(weekly_summary),study_streak=VALUES(study_streak)',
      [req.user.id, Boolean(deadline_reminders), Boolean(weekly_summary), Boolean(study_streak)]
    );
    res.json({ message: 'Postavke su spremljene.' });
  })
);

router.put(
  '/me',
  asyncHandler(async (req, res) => {
    const { name, email, program } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        message: 'Ime i e-mail su obavezni.'
      });
    }

    try {
      await pool.query(
        `
        UPDATE users
        SET
          name = ?,
          email = ?,
          program = ?
        WHERE id = ?
        `,
        [name.trim(), email.toLowerCase(), program?.trim() || null, req.user.id]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          message: 'E-mail je već zauzet.'
        });
      }

      throw error;
    }

    const [rows] = await pool.query(
      'SELECT id, name, email, program, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json(rows[0]);
  })
);

export default router;
