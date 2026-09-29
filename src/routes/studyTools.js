import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AiUnavailableError, generateGeminiJson } from '../gemini.js';

const router = Router();
router.use(requireAuth);
const uploadsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');

async function ownsSubject(subjectId, userId) {
  const [rows] = await pool.query('SELECT id FROM subjects WHERE id=? AND user_id=?', [
    subjectId,
    userId
  ]);
  return rows.length > 0;
}
async function ownCard(id, userId) {
  const [rows] = await pool.query(
    'SELECT f.* FROM flashcards f JOIN subjects s ON s.id=f.subject_id WHERE f.id=? AND s.user_id=?',
    [id, userId]
  );
  return rows[0];
}
async function ownQuiz(id, userId) {
  const [rows] = await pool.query(
    'SELECT q.* FROM quizzes q JOIN subjects s ON s.id=q.subject_id WHERE q.id=? AND s.user_id=?',
    [id, userId]
  );
  return rows[0];
}
async function createQuiz({ subjectId, title, difficulty, source, questions }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [quiz] = await connection.query(
      'INSERT INTO quizzes (subject_id,title,difficulty,source) VALUES (?,?,?,?)',
      [subjectId, title.slice(0, 180), difficulty, source]
    );
    for (const item of questions) {
      const options = Array.isArray(item.options)
        ? item.options.map(String).filter(Boolean).slice(0, 4)
        : [];
      const correct = Number(item.correct_index);
      if (
        !item.question?.trim() ||
        options.length < 2 ||
        !Number.isInteger(correct) ||
        correct < 0 ||
        correct >= options.length
      )
        continue;
      await connection.query(
        'INSERT INTO quiz_questions (quiz_id,question,options_json,correct_index,explanation) VALUES (?,?,?,?,?)',
        [
          quiz.insertId,
          item.question.trim(),
          JSON.stringify(options),
          correct,
          item.explanation?.trim() || null
        ]
      );
    }
    const [count] = await connection.query(
      'SELECT COUNT(*) AS total FROM quiz_questions WHERE quiz_id=?',
      [quiz.insertId]
    );
    if (!count[0].total) throw new Error('Kviz mora imati barem jedno ispravno pitanje.');
    await connection.commit();
    return quiz.insertId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const [due] = await pool.query(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT f.subject_id) AS subjects FROM flashcards f JOIN subjects s ON s.id=f.subject_id WHERE s.user_id=? AND (f.next_review_at IS NULL OR f.next_review_at <= NOW())`,
      [userId]
    );
    const [mastery] = await pool.query(
      `SELECT COUNT(*) AS total, SUM(f.status='mastered') AS mastered FROM flashcards f JOIN subjects s ON s.id=f.subject_id WHERE s.user_id=?`,
      [userId]
    );
    const [week] = await pool.query(
      `SELECT COALESCE(SUM(duration_minutes),0) AS minutes FROM study_sessions WHERE user_id=? AND completed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      [userId]
    );
    const [goals] = await pool.query(
      'SELECT * FROM study_goals WHERE user_id=? ORDER BY is_completed, due_date IS NULL, due_date, created_at DESC',
      [userId]
    );
    // Minute učenja po danu za TEKUĆI kalendarski tjedan (pon-ned) — za mini bar chart na Timer stranici.
    const [dailyRows] = await pool.query(
      `SELECT WEEKDAY(completed_at) AS dow, SUM(duration_minutes) AS minutes FROM study_sessions WHERE user_id=? AND completed_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) GROUP BY WEEKDAY(completed_at)`,
      [userId]
    );
    const minutesByDow = new Array(7).fill(0);
    dailyRows.forEach(r => {
      minutesByDow[r.dow] = Number(r.minutes);
    });
    const week_breakdown = ['Pon', 'Uto', 'Sri', 'Čet', 'Pet', 'Sub', 'Ned'].map((day, i) => ({
      day,
      minutes: minutesByDow[i]
    }));
    res.json({
      due: due[0],
      mastery: mastery[0],
      week_minutes: week[0].minutes,
      week_breakdown,
      goals
    });
  })
);

router.get(
  '/flashcards',
  asyncHandler(async (req, res) => {
    const dueOnly = req.query.due === '1';
    const [cards] = await pool.query(
      `SELECT f.*,s.name AS subject_name,s.color AS subject_color FROM flashcards f JOIN subjects s ON s.id=f.subject_id WHERE s.user_id=? ${dueOnly ? 'AND (f.next_review_at IS NULL OR f.next_review_at <= NOW())' : ''} ORDER BY f.next_review_at IS NULL DESC,f.next_review_at ASC,f.created_at DESC`,
      [req.user.id]
    );
    res.json(cards);
  })
);

router.post(
  '/flashcards',
  asyncHandler(async (req, res) => {
    const { subject_id, question, answer } = req.body;
    if (!subject_id || !question?.trim() || !answer?.trim())
      return res.status(400).json({ message: 'Predmet, pitanje i odgovor su obavezni.' });
    if (!(await ownsSubject(subject_id, req.user.id)))
      return res.status(404).json({ message: 'Predmet nije pronađen.' });
    const [result] = await pool.query(
      'INSERT INTO flashcards (subject_id,question,answer,next_review_at) VALUES (?,?,?,NOW())',
      [subject_id, question.trim(), answer.trim()]
    );
    res.status(201).json({ id: result.insertId });
  })
);

router.post(
  '/flashcards/:id/review',
  asyncHandler(async (req, res) => {
    const { rating } = req.body;
    if (!['hard', 'good', 'easy'].includes(rating))
      return res.status(400).json({ message: 'Odaberite Teško, Dobro ili Lako.' });
    const card = await ownCard(req.params.id, req.user.id);
    if (!card) return res.status(404).json({ message: 'Kartica nije pronađena.' });
    const hours = rating === 'hard' ? 6 : rating === 'good' ? 48 : 24 * 5;
    const status = rating === 'easy' ? 'mastered' : 'learning';
    await pool.query(
      `UPDATE flashcards SET status=?,last_reviewed_at=NOW(),next_review_at=DATE_ADD(NOW(), INTERVAL ? HOUR) WHERE id=?`,
      [status, hours, card.id]
    );
    await pool.query('INSERT INTO flashcard_reviews (flashcard_id,rating) VALUES (?,?)', [
      card.id,
      rating
    ]);
    res.json({ message: 'Kartica je ažurirana.' });
  })
);

router.delete(
  '/flashcards/:id',
  asyncHandler(async (req, res) => {
    const card = await ownCard(req.params.id, req.user.id);
    if (!card) return res.status(404).json({ message: 'Kartica nije pronađena.' });
    await pool.query('DELETE FROM flashcards WHERE id=?', [card.id]);
    res.status(204).end();
  })
);

router.get(
  '/quizzes',
  asyncHandler(async (req, res) => {
    const [quizzes] = await pool.query(
      `SELECT q.*,s.name AS subject_name,s.color AS subject_color,(SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id=q.id) AS question_count FROM quizzes q JOIN subjects s ON s.id=q.subject_id WHERE s.user_id=? ORDER BY q.created_at DESC`,
      [req.user.id]
    );
    res.json(quizzes);
  })
);

router.get(
  '/quizzes/:id',
  asyncHandler(async (req, res) => {
    const quiz = await ownQuiz(req.params.id, req.user.id);
    if (!quiz) return res.status(404).json({ message: 'Kviz nije pronađen.' });
    const [questions] = await pool.query(
      'SELECT id,question,options_json,explanation FROM quiz_questions WHERE quiz_id=?',
      [quiz.id]
    );
    // options_json je MySQL JSON kolona — mysql2 je vrati već parsiranu kao niz, pa JSON.parse ovdje puca (poziv na array baca SyntaxError).
    res.json({
      ...quiz,
      questions: questions.map(({ options_json, ...q }) => ({
        ...q,
        options: Array.isArray(options_json) ? options_json : JSON.parse(options_json)
      }))
    });
  })
);

router.post(
  '/quizzes',
  asyncHandler(async (req, res) => {
    const { subject_id, title, difficulty = 'medium', questions } = req.body;
    if (!subject_id || !title?.trim() || !Array.isArray(questions))
      return res.status(400).json({ message: 'Predmet, naslov i pitanje su obavezni.' });
    if (!(await ownsSubject(subject_id, req.user.id)))
      return res.status(404).json({ message: 'Predmet nije pronađen.' });
    const id = await createQuiz({
      subjectId: subject_id,
      title: title.trim(),
      difficulty,
      source: 'manual',
      questions
    });
    res.status(201).json({ id });
  })
);

router.post(
  '/quizzes/:id/submit',
  asyncHandler(async (req, res) => {
    const quiz = await ownQuiz(req.params.id, req.user.id);
    if (!quiz) return res.status(404).json({ message: 'Kviz nije pronađen.' });
    const answers = req.body.answers || {};
    const [questions] = await pool.query(
      'SELECT id,question,options_json,correct_index,explanation FROM quiz_questions WHERE quiz_id=?',
      [quiz.id]
    );
    const correct = questions.filter(q => Number(answers[q.id]) === q.correct_index).length;
    const score = questions.length ? Number(((correct / questions.length) * 100).toFixed(2)) : 0;
    await pool.query(
      'INSERT INTO quiz_attempts (quiz_id,correct_count,total_count,score) VALUES (?,?,?,?)',
      [quiz.id, correct, questions.length, score]
    );
    await pool.query('UPDATE quizzes SET last_score=?,last_correct=?,last_total=? WHERE id=?', [
      score,
      correct,
      questions.length,
      quiz.id
    ]);
    // Pregled po pitanju za prikaz nakon završetka kviza — bodovanje iznad ostaje nepromijenjeno, ovo je samo dodatni podatak za review.
    const breakdown = questions.map(q => {
      const options = Array.isArray(q.options_json) ? q.options_json : JSON.parse(q.options_json); // options_json je MySQL JSON kolona, mysql2 je već parsira
      const userIndex =
        answers[q.id] === undefined || answers[q.id] === null || answers[q.id] === ''
          ? null
          : Number(answers[q.id]);
      return {
        id: q.id,
        question: q.question,
        options,
        user_index: userIndex,
        correct_index: q.correct_index,
        is_correct: userIndex === q.correct_index,
        explanation: q.explanation || null
      };
    });
    res.json({ correct, total: questions.length, score, breakdown });
  })
);

router.post(
  '/sessions',
  asyncHandler(async (req, res) => {
    const { subject_id, duration_minutes } = req.body;
    const minutes = Number(duration_minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720)
      return res.status(400).json({ message: 'Trajanje mora biti između 1 i 720 minuta.' });
    if (subject_id && !(await ownsSubject(subject_id, req.user.id)))
      return res.status(404).json({ message: 'Predmet nije pronađen.' });
    await pool.query(
      'INSERT INTO study_sessions (user_id,subject_id,duration_minutes) VALUES (?,?,?)',
      [req.user.id, subject_id || null, minutes]
    );
    res.status(201).json({ message: 'Sesija učenja je spremljena.' });
  })
);

router.post(
  '/goals',
  asyncHandler(async (req, res) => {
    const { title, target_minutes = 0, due_date = null } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: 'Naziv cilja je obavezan.' });
    const [result] = await pool.query(
      'INSERT INTO study_goals (user_id,title,target_minutes,due_date) VALUES (?,?,?,?)',
      [req.user.id, title.trim(), Math.max(0, Number(target_minutes) || 0), due_date || null]
    );
    res.status(201).json({ id: result.insertId });
  })
);
router.patch(
  '/goals/:id',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query(
      'UPDATE study_goals SET is_completed=? WHERE id=? AND user_id=?',
      [req.body.is_completed ? 1 : 0, req.params.id, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Cilj nije pronađen.' });
    res.json({ message: 'Cilj je ažuriran.' });
  })
);
router.delete(
  '/goals/:id',
  asyncHandler(async (req, res) => {
    const [result] = await pool.query('DELETE FROM study_goals WHERE id=? AND user_id=?', [
      req.params.id,
      req.user.id
    ]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Cilj nije pronađen.' });
    res.status(204).end();
  })
);

router.post(
  '/ai/generate',
  asyncHandler(async (req, res) => {
    const {
      type,
      material_id,
      count = 10,
      difficulty = 'medium',
      notes,
      daily_hours,
      unavailable_days,
      preferred_start,
      preferred_end,
      question,
      history
    } = req.body;
    if (!['flashcards', 'quiz', 'summary', 'auto_calendar', 'ask'].includes(type))
      return res.status(400).json({ message: 'Odaberite AI radnju.' });
    if (type === 'auto_calendar') {
      const [subjects] = await pool.query('SELECT id FROM subjects WHERE user_id=?', [req.user.id]);
      if (!subjects.length)
        return res
          .status(400)
          .json({ message: 'Dodaj barem jedan predmet prije generiranja AI kalendara.' });
      const [tasks] = await pool.query(
        `SELECT t.subject_id, t.title, t.due_date, t.priority, t.estimated_hours, t.type FROM tasks t JOIN subjects s ON s.id=t.subject_id WHERE s.user_id=? AND t.is_completed=0 ORDER BY t.due_date IS NULL, t.due_date`,
        [req.user.id]
      );
      if (!tasks.length)
        return res
          .status(400)
          .json({
            message: 'Dodaj barem jednu otvorenu obavezu s rokom prije generiranja AI kalendara.'
          });
      const [weekly] = await pool.query(
        `SELECT sc.day_of_week, sc.start_time, sc.end_time FROM schedule sc JOIN subjects s ON s.id=sc.subject_id WHERE s.user_id=?`,
        [req.user.id]
      );
      // Već PRIHVAĆENI prijedlozi iz prijašnjih generacija ostaju netaknuti (regeneracija briše samo one koji još čekaju odluku) i računaju se kao zauzeti termini da se novi prijedlozi ne preklope s njima.
      const [accepted] = await pool.query(
        `SELECT subject_id, title, scheduled_date, start_time, end_time FROM ai_calendar_events WHERE user_id=? AND status='accepted'`,
        [req.user.id]
      );
      // Obaveza koja je već prihvaćena (negdje već ima svoj termin u kalendaru) se ne predlaže ponovno — spriječava duple prijedloge za istu stvar.
      const alreadyAcceptedTasks = new Set(accepted.map(a => `${a.subject_id}::${a.title}`));
      // Slabiji prosjek na predmetu gura obavezu ranije unutar iste razine prioriteta.
      const [gradeRows] = await pool.query(
        `SELECT g.subject_id, AVG(g.value) AS avg_grade FROM grades g JOIN subjects s ON s.id=g.subject_id WHERE s.user_id=? GROUP BY g.subject_id`,
        [req.user.id]
      );
      const weakSubjects = new Set(
        gradeRows.filter(r => Number(r.avg_grade) < 3.5).map(r => r.subject_id)
      );

      // Opcionalna pravila iz popupa.
      const maxHours = Number(daily_hours);
      const dailyCapMinutes =
        Number.isInteger(maxHours) && maxHours > 0 && maxHours <= 12 ? maxHours * 60 : null;
      const offDays = new Set(
        Array.isArray(unavailable_days)
          ? unavailable_days.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7)
          : []
      );
      const prefStart = /^\d{2}:\d{2}$/.test(preferred_start || '') ? preferred_start : null;
      const prefEnd = /^\d{2}:\d{2}$/.test(preferred_end || '') ? preferred_end : null;

      // --- Datumska aritmetika u LOKALNOM vremenu (ne toISOString/UTC — to bi na pola svjetskih vremenskih zona pomaknulo datum za jedan dan). ---
      const startOfDay = d => {
        const x = new Date(d);
        x.setHours(0, 0, 0, 0);
        return x;
      };
      const addDays = (d, n) => {
        const x = new Date(d);
        x.setDate(x.getDate() + n);
        return x;
      };
      const toISODate = d =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const dowOf = d => ((d.getDay() + 6) % 7) + 1; // JS getDay() 0=ned...6=sub -> ovdje 1=pon...7=ned (isto kao schedule.day_of_week)
      const toMinutes = hhmm => {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
      };
      const addMinutes = (hhmm, mins) => {
        const total = toMinutes(hhmm) + mins;
        return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      };
      const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;
      const today = startOfDay(new Date());

      // Prioritet obaveze -> broj (manji = važnije); slabiji predmet blago gura obavezu ranije unutar iste razine prioriteta.
      const priorityRank = { high: 0, medium: 1, low: 2 };
      const activeTasks = tasks.slice(0, 30).map(t => ({
        ...t,
        priority: ['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium',
        dueDate: t.due_date ? startOfDay(new Date(t.due_date)) : null
      }));
      // Zahtjev: prvo prioritet (Visok prvo), zatim hitnost roka (najbliži rok prvo) — ne redoslijed kojim su obaveze kreirane.
      activeTasks.sort((a, b) => {
        const rankA = priorityRank[a.priority] - (weakSubjects.has(a.subject_id) ? 0.5 : 0);
        const rankB = priorityRank[b.priority] - (weakSubjects.has(b.subject_id) ? 0.5 : 0);
        if (rankA !== rankB) return rankA - rankB;
        const dueA = a.dueDate ? a.dueDate.getTime() : Infinity;
        const dueB = b.dueDate ? b.dueDate.getTime() : Infinity;
        return dueA - dueB;
      });

      // Raznoliki termini kroz dan — svaka obaveza kreće od drugog mjesta u ovom nizu, umjesto da sve padnu na isto vrijeme (npr. uvijek 13:00).
      const TIME_SLOTS = [
        '08:00',
        '09:30',
        '11:00',
        '13:00',
        '14:30',
        '16:00',
        '17:30',
        '19:00',
        '20:00'
      ];
      const durationFor = task => (Number(task.estimated_hours) >= 3 ? 90 : 60); // realan blok: 60 min, ili 90 min za zahtjevnije obaveze

      // Cilj: učenje 1-3 dana PRIJE stvarnog roka (ne mehanički "sljedeći slobodan dan") — probaj redom 2, pa 1, pa 3 dana prije (sweet spot na sredini).
      function candidateDates(task) {
        if (!task.dueDate) return [3, 4, 5, 6, 7, 8, 9, 10].map(n => addDays(today, n)); // bez roka — dalje u budućnost, da ne istisne hitnije obaveze
        const daysUntil = Math.round((task.dueDate - today) / 86400000);
        if (daysUntil < 0) return [addDays(today, 1), addDays(today, 2), today]; // zakašnjelo — hitno, u sljedeća 1-2 dana
        if (daysUntil === 0) return [today];
        const offsets = [2, 1, 3].filter(off => off <= daysUntil);
        return offsets.length ? offsets.map(off => addDays(task.dueDate, -off)) : [task.dueDate]; // rok je sutra/prekosutra — nema puno prostora, zakaži na sam dan ako ništa drugo ne stane
      }

      const bookedByDate = new Map(); // datum -> zauzeti termini (već prihvaćeni prijedlozi + novopostavljeni u ovoj generaciji)
      accepted.forEach(a => {
        const dateISO = toISODate(startOfDay(new Date(a.scheduled_date)));
        bookedByDate.set(dateISO, [
          ...(bookedByDate.get(dateISO) || []),
          { start: a.start_time.slice(0, 5), end: a.end_time.slice(0, 5) }
        ]);
      });
      function isFree(dateISO, dow, start, end) {
        if (
          weekly.some(
            w =>
              w.day_of_week === dow &&
              overlaps(start, end, w.start_time.slice(0, 5), w.end_time.slice(0, 5))
          )
        )
          return false; // preklapa se s postojećim predavanjem/vježbama tog dana
        const existing = bookedByDate.get(dateISO) || [];
        if (existing.some(b => overlaps(start, end, b.start, b.end))) return false; // preklapa se s drugim već postavljenim AI terminom tog dana
        if (dailyCapMinutes !== null) {
          const used = existing.reduce(
            (sum, b) => sum + (toMinutes(b.end) - toMinutes(b.start)),
            0
          );
          if (used + (toMinutes(end) - toMinutes(start)) > dailyCapMinutes) return false;
        }
        return true;
      }

      // Objašnjenje "zašto baš ovaj termin" — rok + koji je dan/doba dana stvarno slobodno. Ton se prilagođava hitnosti: visok prioritet+blizak rok = direktniji, nizak prioritet+dalek rok = opušteniji.
      const DAY_INFO = [
        { name: 'ponedjeljak', fem: false },
        { name: 'utorak', fem: false },
        { name: 'srijeda', fem: true },
        { name: 'četvrtak', fem: false },
        { name: 'petak', fem: false },
        { name: 'subota', fem: true },
        { name: 'nedjelja', fem: true }
      ];
      const timeOfDay = hhmm => {
        const h = Number(hhmm.slice(0, 2));
        return h < 12 ? 'ujutro' : h < 18 ? 'popodne' : 'navečer';
      };
      function reasonFor(task, slot, daysUntil) {
        const day = DAY_INFO[dowOf(new Date(`${slot.date}T00:00:00`)) - 1];
        const free = `${day.name} ti je slobod${day.fem ? 'na' : 'an'} ${timeOfDay(slot.start)}`;
        if (daysUntil === null)
          return `Ova obaveza nema postavljen rok, ali ${free} — kad nađeš vremena, ovo bi bilo dobro odraditi.`;
        if (daysUntil <= 0)
          return `Rok je danas (ili je već prošao) — hitno je, zato je odmah zakazano čim prije: ${free}.`;
        const dayText = daysUntil === 1 ? '1 dan' : `${daysUntil} dana`;
        if (task.priority === 'high' && daysUntil <= 5)
          return `Rok je za ${dayText} — preporučam da ovo odradiš uskoro, ${free}.`;
        if (task.priority === 'low' && daysUntil > 14)
          return `Kad nađeš vremena, ovo bi bilo dobro odraditi — rok je tek za ${dayText}, a ${free}.`;
        return `Predlažem ovo jer imaš rok za tu obavezu za ${dayText}, a ${free}.`;
      }

      const MAX_PROPOSALS = 3; // ne prezasititi listu — ali dovoljno da plan izgleda kao stvaran raspored, ne samo "sljedeća 1 stvar"
      const placed = [];
      for (
        let taskIdx = 0;
        taskIdx < activeTasks.length && placed.length < MAX_PROPOSALS;
        taskIdx++
      ) {
        const task = activeTasks[taskIdx];
        if (alreadyAcceptedTasks.has(`${task.subject_id}::${task.title.slice(0, 180)}`)) continue; // već prihvaćeno negdje u kalendaru — ne predlaži je opet
        // Plan ostaje blizak i djelotvoran — obaveze s rokom dalje od ~2 mjeseca se ne guraju u ovu generaciju (dobit će termin u budućoj generaciji kad im se rok približi).
        const daysUntil = task.dueDate ? Math.round((task.dueDate - today) / 86400000) : null;
        if (daysUntil !== null && daysUntil > 60) continue;
        const duration = durationFor(task);
        let slot = null;
        for (const date of candidateDates(task)) {
          const dow = dowOf(date);
          if (offDays.has(dow)) continue;
          const dateISO = toISODate(date);
          for (let i = 0; i < TIME_SLOTS.length; i++) {
            const start = TIME_SLOTS[(i + taskIdx * 2) % TIME_SLOTS.length]; // rotacija po obavezi -> stvarno različita vremena, ne uvijek prvi slobodan slot
            if (prefStart && start < prefStart) continue;
            const end = addMinutes(start, duration);
            if (prefEnd && end > prefEnd) continue;
            if (isFree(dateISO, dow, start, end)) {
              slot = { date: dateISO, start, end };
              break;
            }
          }
          if (slot) break;
        }
        if (!slot) continue; // nema slobodnog termina za ovu obavezu unutar dostupnih dana/sati — preskoči je, ne izmišljaj preklapanje
        bookedByDate.set(slot.date, [
          ...(bookedByDate.get(slot.date) || []),
          { start: slot.start, end: slot.end }
        ]);
        placed.push({ task, ...slot, reason: reasonFor(task, slot, daysUntil) });
      }

      if (!placed.length)
        return res
          .status(400)
          .json({
            message:
              'Nije pronađen slobodan termin ni za jednu obavezu — provjeri raspored ili ograničenja (dostupni dani/sati) i pokušaj ponovno.'
          });

      // Regeneriranje ZAMJENJUJE prethodne PENDING prijedloge (već PRIHVAĆENI ostaju netaknuti — to je korisnikova odluka, ne briše se automatski).
      await pool.query(`DELETE FROM ai_calendar_events WHERE user_id=? AND status='pending'`, [
        req.user.id
      ]);
      for (const p of placed) {
        await pool.query(
          'INSERT INTO ai_calendar_events (user_id,subject_id,title,scheduled_date,start_time,end_time,room,event_type,priority,status,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [
            req.user.id,
            p.task.subject_id,
            p.task.title.slice(0, 180),
            p.date,
            p.start,
            p.end,
            null,
            'Učenje',
            p.task.priority,
            'pending',
            p.reason
          ]
        );
      }

      // Datumi/vremena su već ispravno izračunati gore (deterministički) — AI ovdje piše ISKLJUČIVO jednu prigodnu rečenicu o već gotovom planu, ne odlučuje raspored. Ako AI poziv padne, koristi se jednostavna generirana rečenica umjesto da cijela značajka pukne.
      const top = placed[0];
      const topDays = top.task.dueDate ? Math.round((top.task.dueDate - today) / 86400000) : null;
      let recommendation =
        topDays === null
          ? `Kreni s "${top.task.title}" — zakazano ${top.date} u ${top.start}.`
          : `Prioritet ti je "${top.task.title}" — rok je ${topDays <= 0 ? 'vrlo skoro' : `za ${topDays} dana`}, zato je učenje zakazano ${top.date} u ${top.start}.`;
      try {
        const cleanNotes = typeof notes === 'string' ? notes.trim().slice(0, 300) : '';
        const ai = await generateGeminiJson({
          prompt: `Napiši JEDNU kratku, konkretnu i ohrabrujuću rečenicu na hrvatskom za studenta o njegovom planu učenja. Spominje obavezu "${top.task.title}" (prioritet ${top.task.priority}), zakazanu za ${top.date} u ${top.start}.${cleanNotes ? ` Napomena studenta za ovaj tjedan: ${cleanNotes}.` : ''} Vrati ISKLJUČIVO JSON oblika {"recommendation":"..."} bez markdowna.`
        });
        if (ai?.recommendation && typeof ai.recommendation === 'string')
          recommendation = ai.recommendation.trim().slice(0, 400);
      } catch {
        /* preporuka je kozmetički dodatak — kalendar je već ispravno generiran bez obzira na ovo */
      }

      return res
        .status(201)
        .json({
          type,
          created: placed.length,
          recommendation,
          message: `Generiran je kalendar s ${placed.length} prijedloga termina, ispod postojećeg rasporeda.`
        });
    }
    if (!material_id) return res.status(400).json({ message: 'Odaberite PDF materijal.' });
    if (type === 'ask' && !question?.trim())
      return res.status(400).json({ message: 'Unesite pitanje.' });
    const [materials] = await pool.query(
      `SELECT m.*,s.name AS subject_name FROM materials m JOIN subjects s ON s.id=m.subject_id WHERE m.id=? AND s.user_id=?`,
      [material_id, req.user.id]
    );
    const material = materials[0];
    if (!material) return res.status(404).json({ message: 'Materijal nije pronađen.' });
    if (material.mime_type !== 'application/pdf')
      return res.status(400).json({ message: 'AI alati trenutačno podržavaju PDF materijale.' });
    let file;
    try {
      file = {
        mimeType: material.mime_type,
        base64: await fs.readFile(path.join(uploadsDir, material.storage_name), 'base64')
      };
    } catch {
      return res.status(404).json({ message: 'Datoteka materijala nije pronađena.' });
    }
    const amount = Math.max(5, Math.min(type === 'flashcards' ? 30 : 20, Number(count) || 10));
    // Zadnjih par razmjena iz razgovora (ako ih ima) da AI razumije kontekst na follow-up pitanja poput "a zašto...".
    const historyText =
      Array.isArray(history) && history.length
        ? `\nPrethodni razgovor:\n${history
            .slice(-6)
            .map(
              h =>
                `Student: ${String(h.question || '').slice(0, 300)}\nAI: ${String(h.answer || '').slice(0, 500)}`
            )
            .join('\n')}\n`
        : '';
    const prompts = {
      flashcards: `Iz ovog PDF-a napravi ${amount} kvalitetnih kartica za učenje na hrvatskom jeziku. Vrati ISKLJUČIVO JSON niz objekata oblika {"question":"...","answer":"..."}. Bez markdowna.`,
      quiz: `Iz ovog PDF-a napravi kviz od ${amount} pitanja na hrvatskom jeziku, težine ${difficulty}. Vrati ISKLJUČIVO JSON niz objekata oblika {"question":"...","options":["A","B","C","D"],"correct_index":0,"explanation":"..."}. Točan odgovor je indeks 0-3. Bez markdowna.`,
      summary: `Napiši strukturiran, jasan sažetak ovog PDF-a na hrvatskom jeziku. Koristi naslove, podnaslove i kratke točke. Vrati ISKLJUČIVO JSON objekt oblika {"title":"Sažetak — ...","content":"..."}.`,
      // Tutor je instruiran da odgovara isključivo iz priloženog PDF-a, kako bi se smanjila (ne i potpuno spriječila) mogućnost izmišljanja odgovora — sam prompt ne jamči da model neće halucinirati.
      ask: `Ti si AI tutor. Odgovaraj ISKLJUČIVO na osnovu sadržaja priloženog PDF materijala, na hrvatskom jeziku. Ako pitanje nije pokriveno materijalom, jasno reci da materijal ne sadrži odgovor na to pitanje — ne izmišljaj i ne koristi opće znanje izvan materijala.${historyText}\nPitanje studenta: ${String(
        question || ''
      )
        .trim()
        .slice(0, 500)}\n\nVrati ISKLJUČIVO JSON objekt oblika {"answer":"..."}. Bez markdowna.`
    };
    try {
      const generated = await generateGeminiJson({ prompt: prompts[type], file });
      if (type === 'ask') {
        if (!generated?.answer)
          throw new AiUnavailableError('AI nije uspio odgovoriti. Pokušajte ponovno.');
        return res.json({ type, answer: String(generated.answer).trim().slice(0, 4000) });
      }
      if (type === 'flashcards') {
        if (!Array.isArray(generated) || !generated.length)
          throw new AiUnavailableError('AI nije generirao kartice. Pokušajte ponovno kasnije.');
        const cards = generated
          .filter(item => item.question?.trim() && item.answer?.trim())
          .slice(0, 30);
        for (const card of cards)
          await pool.query(
            'INSERT INTO flashcards (subject_id,question,answer,source,next_review_at) VALUES (?,?,?,?,NOW())',
            [material.subject_id, card.question.trim(), card.answer.trim(), 'ai']
          );
        return res
          .status(201)
          .json({
            type,
            created: cards.length,
            message: `Spremljeno je ${cards.length} AI kartica.`
          });
      }
      if (type === 'quiz') {
        if (!Array.isArray(generated) || !generated.length)
          throw new AiUnavailableError('AI nije generirao kviz. Pokušajte ponovno kasnije.');
        const id = await createQuiz({
          subjectId: material.subject_id,
          title: `AI kviz — ${material.filename}`,
          difficulty: ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium',
          source: 'ai',
          questions: generated
        });
        return res.status(201).json({ type, id, message: 'AI kviz je spremljen.' });
      }
      if (!generated?.title || !generated?.content)
        throw new AiUnavailableError('AI nije generirao sažetak. Pokušajte ponovno kasnije.');
      return res.json({
        type,
        subject_id: material.subject_id,
        title: String(generated.title).slice(0, 180),
        content: String(generated.content)
      });
    } catch (error) {
      if (error instanceof AiUnavailableError)
        return res
          .status(503)
          .json({ code: 'AI_UNAVAILABLE', message: error.message, manual_available: true });
      throw error;
    }
  })
);

export default router;
