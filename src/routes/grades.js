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
        g.*,
        s.name AS subject_name,
        s.color AS subject_color
      FROM grades g
      JOIN subjects s
        ON s.id = g.subject_id
      WHERE s.user_id = ?
      ${req.query.subjectId ? 'AND s.id = ?' : ''}
      ORDER BY g.graded_at DESC
      `,
      req.query.subjectId ? [req.user.id, req.query.subjectId] : [req.user.id]
    );

    res.json(rows);
  })
);

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT s.id,s.name,s.color,s.semester,s.ects,COUNT(g.id) AS grade_count,ROUND(AVG(g.value),2) AS average_grade FROM subjects s LEFT JOIN grades g ON g.subject_id=s.id WHERE s.user_id=? GROUP BY s.id ORDER BY s.semester,s.name`,
      [req.user.id]
    );
    const subjects = rows.map(row => ({
      ...row,
      semester: Number(row.semester),
      ects: Number(row.ects),
      average_grade: row.average_grade === null ? null : Number(row.average_grade),
      grade_count: Number(row.grade_count)
    }));
    const grouped = new Map();
    for (const subject of subjects) {
      const data = grouped.get(subject.semester) || {
        semester: subject.semester,
        averages: [],
        passed: 0,
        failed: 0,
        ects_total: 0,
        ects_earned: 0
      };
      data.ects_total += subject.ects;
      if (subject.average_grade !== null) {
        data.averages.push(subject.average_grade);
        if (subject.average_grade >= 2) {
          data.passed++;
          data.ects_earned += subject.ects;
        } else data.failed++;
      }
      grouped.set(subject.semester, data);
    }
    const semesters = [...grouped.values()].map(data => ({
      ...data,
      average: data.averages.length
        ? Number(
            (data.averages.reduce((sum, value) => sum + value, 0) / data.averages.length).toFixed(2)
          )
        : null,
      averages: undefined
    }));
    const graded = subjects.filter(subject => subject.average_grade !== null);
    res.json({
      subjects,
      semesters,
      totals: {
        average: graded.length
          ? Number(
              (
                graded.reduce((sum, subject) => sum + subject.average_grade, 0) / graded.length
              ).toFixed(2)
            )
          : null,
        passed: graded.filter(subject => subject.average_grade >= 2).length,
        failed: graded.filter(subject => subject.average_grade < 2).length,
        ects_total: subjects.reduce((sum, subject) => sum + subject.ects, 0),
        ects_earned: graded
          .filter(subject => subject.average_grade >= 2)
          .reduce((sum, subject) => sum + subject.ects, 0)
      }
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { subject_id, value, description, graded_at } = req.body;

    if (
      !subject_id ||
      value === undefined ||
      !graded_at ||
      Number(value) < 1 ||
      Number(value) > 5
    ) {
      return res.status(400).json({
        message: 'Unesite predmet, ocjenu od 1 do 5 i datum.'
      });
    }

    const [result] = await pool.query(
      `
      INSERT INTO grades (
        subject_id,
        value,
        description,
        graded_at
      )
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM subjects
        WHERE id = ?
          AND user_id = ?
      )
      `,
      [subject_id, value, description?.trim() || null, graded_at, subject_id, req.user.id]
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
    const { subject_id, value, description, graded_at } = req.body;
    if (
      !subject_id ||
      value === undefined ||
      !graded_at ||
      Number(value) < 1 ||
      Number(value) > 5
    ) {
      return res.status(400).json({ message: 'Unesite predmet, ocjenu od 1 do 5 i datum.' });
    }

    const [result] = await pool.query(
      `UPDATE grades g
       JOIN subjects current_subject ON current_subject.id = g.subject_id
       JOIN subjects selected_subject ON selected_subject.id = ?
       SET g.subject_id = ?, g.value = ?, g.description = ?, g.graded_at = ?
       WHERE g.id = ? AND current_subject.user_id = ? AND selected_subject.user_id = ?`,
      [
        subject_id,
        subject_id,
        value,
        description?.trim() || null,
        graded_at,
        req.params.id,
        req.user.id,
        req.user.id
      ]
    );

    if (!result.affectedRows) return res.status(404).json({ message: 'Ocjena nije pronađena.' });
    res.json({ message: 'Ocjena je ažurirana.' });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query(
      `
      DELETE g
      FROM grades g
      JOIN subjects s
        ON s.id = g.subject_id
      WHERE g.id = ?
        AND s.user_id = ?
      `,
      [req.params.id, req.user.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        message: 'Ocjena nije pronađena.'
      });
    }

    res.status(204).end();
  })
);

export default router;
