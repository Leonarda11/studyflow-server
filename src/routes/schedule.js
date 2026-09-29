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
    SELECT sc.*, s.name AS subject_name, s.code AS subject_code, s.color AS subject_color
    FROM schedule sc
    JOIN subjects s ON s.id = sc.subject_id
    WHERE s.user_id = ?
    ORDER BY sc.day_of_week, sc.start_time
  `,
      [req.user.id]
    );
    res.json(rows);
  })
);

router.get(
  '/ai-proposals',
  asyncHandler(async (req, res) => {
    // Prikaz ide po prioritetu (Visok prvo), pa po hitnosti termina — ne kronološki po datumu kreiranja/rasporeda.
    const [rows] = await pool.query(
      `SELECT e.*,s.name AS subject_name,s.color AS subject_color FROM ai_calendar_events e JOIN subjects s ON s.id=e.subject_id WHERE e.user_id=? ORDER BY FIELD(e.priority,'high','medium','low'),e.scheduled_date,e.start_time`,
      [req.user.id]
    );
    res.json(rows);
  })
);

router.delete(
  '/ai-proposals/:id',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query('DELETE FROM ai_calendar_events WHERE id=? AND user_id=?', [
      req.params.id,
      req.user.id
    ]);
    if (!result.affectedRows)
      return res.status(404).json({ message: 'AI prijedlog nije pronađen.' });
    res.status(204).end();
  })
);

// Prihvaćanje = jednokratna odluka. Prijedlog ne nestaje, nego prelazi u status 'accepted' i time se "spaja" u stvarni kalendar (frontend ga prikazuje unutar tjednog/mjesečnog rasporeda, ne više u listi prijedloga koji čekaju odluku).
router.post(
  '/ai-proposals/:id/accept',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query(
      `UPDATE ai_calendar_events SET status='accepted' WHERE id=? AND user_id=? AND status='pending'`,
      [req.params.id, req.user.id]
    );
    if (!result.affectedRows)
      return res.status(404).json({ message: 'AI prijedlog nije pronađen ili je već obrađen.' });
    res.json({ message: 'Prijedlog je dodan u raspored.' });
  })
);

// Batch akcija — prihvati sve prijedloge koji trenutno čekaju odluku, odjednom.
router.post(
  '/ai-proposals/accept-all',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query(
      `UPDATE ai_calendar_events SET status='accepted' WHERE user_id=? AND status='pending'`,
      [req.user.id]
    );
    res.json({
      message: `${result.affectedRows} prijedloga je dodano u raspored.`,
      accepted: result.affectedRows
    });
  })
);

router.put(
  '/ai-proposals/:id',
  asyncHandler(async (req, res) => {
    const { subject_id, title, scheduled_date, start_time, end_time, room, event_type, priority } =
      req.body;
    if (
      !subject_id ||
      !title?.trim() ||
      !scheduled_date ||
      !start_time ||
      !end_time ||
      start_time >= end_time
    )
      return res.status(400).json({ message: 'Unesite predmet, naziv, datum i ispravno vrijeme.' });
    const [result] = await pool.query(
      `UPDATE ai_calendar_events e JOIN subjects s ON s.id=? SET e.subject_id=?,e.title=?,e.scheduled_date=?,e.start_time=?,e.end_time=?,e.room=?,e.event_type=?,e.priority=? WHERE e.id=? AND e.user_id=? AND s.user_id=?`,
      [
        subject_id,
        subject_id,
        title.trim().slice(0, 180),
        scheduled_date,
        start_time,
        end_time,
        room?.trim() || null,
        event_type || 'Učenje',
        ['low', 'medium', 'high'].includes(priority) ? priority : 'medium',
        req.params.id,
        req.user.id,
        req.user.id
      ]
    );
    if (!result.affectedRows)
      return res.status(404).json({ message: 'AI prijedlog nije pronađen.' });
    res.json({ message: 'AI prijedlog je ažuriran.' });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { subject_id, day_of_week, start_time, end_time, room, class_type } = req.body;
    const day = Number(day_of_week);
    if (!subject_id || !Number.isInteger(day) || day < 1 || day > 7 || !start_time || !end_time) {
      return res.status(400).json({ message: 'Predmet, dan i vrijeme su obavezni.' });
    }
    if (start_time >= end_time) {
      return res
        .status(400)
        .json({ message: 'Vrijeme završetka mora biti nakon vremena početka.' });
    }
    const [result] = await pool.query(
      `
    INSERT INTO schedule (subject_id, day_of_week, start_time, end_time, room, class_type)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM subjects WHERE id = ? AND user_id = ?)
  `,
      [
        subject_id,
        day,
        start_time,
        end_time,
        room?.trim() || null,
        class_type || 'Predavanje',
        subject_id,
        req.user.id
      ]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Predmet nije pronađen.' });
    res.status(201).json({ id: result.insertId });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query(
      `
    DELETE sc FROM schedule sc
    JOIN subjects s ON s.id = sc.subject_id
    WHERE sc.id = ? AND s.user_id = ?
  `,
      [req.params.id, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Termin nije pronađen.' });
    res.status(204).end();
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { subject_id, day_of_week, start_time, end_time, room, class_type } = req.body;
    const day = Number(day_of_week);
    if (
      !subject_id ||
      !Number.isInteger(day) ||
      day < 1 ||
      day > 7 ||
      !start_time ||
      !end_time ||
      start_time >= end_time
    )
      return res.status(400).json({ message: 'Unesi ispravne podatke termina.' });
    const [result] = await pool.query(
      `UPDATE schedule sc JOIN subjects current_subject ON current_subject.id=sc.subject_id JOIN subjects selected_subject ON selected_subject.id=? SET sc.subject_id=?,sc.day_of_week=?,sc.start_time=?,sc.end_time=?,sc.room=?,sc.class_type=? WHERE sc.id=? AND current_subject.user_id=? AND selected_subject.user_id=?`,
      [
        subject_id,
        subject_id,
        day,
        start_time,
        end_time,
        room?.trim() || null,
        class_type || 'Predavanje',
        req.params.id,
        req.user.id,
        req.user.id
      ]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Termin nije pronađen.' });
    res.json({ message: 'Termin je ažuriran.' });
  })
);

export default router;
