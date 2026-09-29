import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const tokenFor = user =>
  jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '90d'
  });

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 6)
      return res
        .status(400)
        .json({ message: 'Unesite ime, ispravan e-mail i lozinku od najmanje 6 znakova.' });
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [
      email.toLowerCase()
    ]);
    if (existing.length)
      return res.status(409).json({ message: 'Korisnik s tim e-mailom već postoji.' });
    const password_hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name.trim(), email.toLowerCase(), password_hash]
    );
    const [rows] = await pool.query(
      'SELECT id, name, email, program, created_at FROM users WHERE id = ?',
      [result.insertId]
    );
    const user = rows[0];
    res.status(201).json({ token: tokenFor(user), user });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email?.toLowerCase()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password || '', user.password_hash)))
      return res.status(401).json({ message: 'Pogrešan e-mail ili lozinka.' });
    res.json({
      token: tokenFor(user),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        program: user.program,
        created_at: user.created_at
      }
    });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      'SELECT id, name, email, program, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json(rows[0]);
  })
);
export default router;
