import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db.js';
import auth from './routes/auth.js';
import users from './routes/users.js';
import subjects from './routes/subjects.js';
import grades from './routes/grades.js';
import tasks from './routes/tasks.js';
import notes from './routes/notes.js';
import dashboard from './routes/dashboard.js';
import schedule from './routes/schedule.js';
import stats from './routes/stats.js';
import materials from './routes/materials.js';
import studyTools from './routes/studyTools.js';
import { initializeStudyToolsSchema } from './studyToolsSchema.js';
dotenv.config();

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:5173'
  })
);

// PDF uploads are sent as Base64; allow the 10 MB limit enforced by the materials route.
app.use(express.json({ limit: '14mb' }));

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');

  res.json({
    status: 'ok'
  });
});

app.use('/api/auth', auth);
app.use('/api/users', users);
app.use('/api/subjects', subjects);
app.use('/api/grades', grades);
app.use('/api/tasks', tasks);
app.use('/api/notes', notes);
app.use('/api/dashboard', dashboard);
app.use('/api/schedule', schedule);
app.use('/api/stats', stats);
app.use('/api/materials', materials);
app.use('/api/study-tools', studyTools);

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    message: 'Došlo je do pogreške na poslužitelju.'
  });
});

async function start() {
  await initializeStudyToolsSchema();
  app.listen(process.env.PORT || 5000, () =>
    console.log(`API sluša na portu ${process.env.PORT || 5000}`)
  );
}

start().catch(error => {
  console.error('Pokretanje API-ja nije uspjelo:', error);
  process.exit(1);
});
