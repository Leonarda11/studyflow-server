import { pool } from './db.js';

const statements = [
  `CREATE TABLE IF NOT EXISTS flashcards (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    subject_id INT UNSIGNED NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    source ENUM('manual','ai') NOT NULL DEFAULT 'manual',
    status ENUM('new','learning','mastered') NOT NULL DEFAULT 'new',
    next_review_at DATETIME NULL,
    last_reviewed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_flashcards_review (next_review_at),
    CONSTRAINT fk_flashcard_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS flashcard_reviews (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    flashcard_id INT UNSIGNED NOT NULL,
    rating ENUM('hard','good','easy') NOT NULL,
    reviewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_review_flashcard FOREIGN KEY (flashcard_id) REFERENCES flashcards(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS quizzes (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    subject_id INT UNSIGNED NOT NULL,
    title VARCHAR(180) NOT NULL,
    difficulty ENUM('easy','medium','hard') NOT NULL DEFAULT 'medium',
    source ENUM('manual','ai') NOT NULL DEFAULT 'manual',
    last_score DECIMAL(5,2) NULL,
    last_correct INT UNSIGNED NULL,
    last_total INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_quiz_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS quiz_questions (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    quiz_id INT UNSIGNED NOT NULL,
    question TEXT NOT NULL,
    options_json JSON NOT NULL,
    correct_index TINYINT UNSIGNED NOT NULL,
    explanation TEXT NULL,
    CONSTRAINT fk_question_quiz FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    quiz_id INT UNSIGNED NOT NULL,
    correct_count INT UNSIGNED NOT NULL,
    total_count INT UNSIGNED NOT NULL,
    score DECIMAL(5,2) NOT NULL,
    completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_attempt_quiz FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS study_sessions (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    subject_id INT UNSIGNED NULL,
    duration_minutes INT UNSIGNED NOT NULL,
    completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_user_date (user_id, completed_at),
    CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_session_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS study_goals (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    title VARCHAR(180) NOT NULL,
    target_minutes INT UNSIGNED NOT NULL DEFAULT 0,
    due_date DATE NULL,
    is_completed TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_goal_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ai_calendar_events (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    subject_id INT UNSIGNED NOT NULL,
    title VARCHAR(180) NOT NULL,
    scheduled_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    room VARCHAR(80) NULL,
    event_type VARCHAR(40) NOT NULL DEFAULT 'Učenje',
    priority ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_calendar_user_date (user_id, scheduled_date),
    CONSTRAINT fk_ai_calendar_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_ai_calendar_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

// status: 'pending' = čeka odluku (prikazan u "AI prijedlozi" review listi), 'accepted' = korisnik prihvatio, spaja se u stvarni tjedni/mjesečni kalendar.
// reason: kratko objašnjenje ZAŠTO je baš taj termin predložen (rok + slobodan dan/doba dana) — generira se deterministički uz svaki prijedlog, ne naknadno.
const aiCalendarEventColumns = ['status', 'reason'];

export async function initializeStudyToolsSchema() {
  for (const statement of statements) await pool.query(statement);
  const [columns] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subjects'
       AND COLUMN_NAME IN ('semester', 'ects')`
  );
  const existing = new Set(columns.map(column => column.COLUMN_NAME));

  if (!existing.has('semester')) {
    await pool.query(
      'ALTER TABLE subjects ADD COLUMN semester TINYINT UNSIGNED NOT NULL DEFAULT 1'
    );
  }
  if (!existing.has('ects')) {
    await pool.query('ALTER TABLE subjects ADD COLUMN ects DECIMAL(5,2) NOT NULL DEFAULT 0');
  }

  const [aiCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_calendar_events'
       AND COLUMN_NAME IN (?)`,
    [aiCalendarEventColumns]
  );
  const existingAiCols = new Set(aiCols.map(c => c.COLUMN_NAME));
  if (!existingAiCols.has('status')) {
    await pool.query(
      `ALTER TABLE ai_calendar_events ADD COLUMN status ENUM('pending','accepted') NOT NULL DEFAULT 'pending'`
    );
  }
  if (!existingAiCols.has('reason')) {
    await pool.query('ALTER TABLE ai_calendar_events ADD COLUMN reason VARCHAR(300) NULL');
  }
}
