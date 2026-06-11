import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const databasePath = path.join(__dirname, 'database', 'bus-qr.sqlite');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const db = await open({
  filename: databasePath,
  driver: sqlite3.Database
});

await db.exec('PRAGMA foreign_keys = ON;');
await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const defaultAdmin = await db.get('SELECT id FROM users WHERE username = ?', 'admin');
if (!defaultAdmin) {
  await db.run(
    'INSERT INTO users (username, password, email, role) VALUES (?, ?, ?, ?)',
    'admin',
    'admin123',
    'admin@busqr.local',
    'admin'
  );
}

await db.exec(`
CREATE TABLE IF NOT EXISTS children (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  age INTEGER,
  gender TEXT,
  school TEXT,
  province TEXT,
  district TEXT,
  start_location TEXT,
  end_location TEXT,
  distance REAL,
  phone_number TEXT,
  qr_code TEXT UNIQUE,
  magnetic_code TEXT UNIQUE,
  season_start_date TEXT,
  season_end_date TEXT,
  status TEXT DEFAULT 'Active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

await db.exec(`
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  child_id INTEGER NOT NULL,
  trip_date TEXT NOT NULL,
  trip_time TEXT NOT NULL,
  trip_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
);
`);

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }
  const user = await db.get('SELECT id, username, email, role FROM users WHERE username = ? AND password = ?', username, password);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  }
  res.json({ success: true, user });
});

app.post('/api/auth/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || !email) {
    return res.status(400).json({ success: false, message: 'Username, password, and email are required.' });
  }

  const existing = await db.get('SELECT id FROM users WHERE username = ? OR email = ?', username, email);
  if (existing) {
    return res.status(409).json({ success: false, message: 'Username or email already exists.' });
  }

  const result = await db.run(
    'INSERT INTO users (username, password, email, role) VALUES (?, ?, ?, ?)',
    username,
    password,
    email,
    'user'
  );

  const user = await db.get('SELECT id, username, email, role FROM users WHERE id = ?', result.lastID);
  res.status(201).json({ success: true, user });
});

app.get('/api/children', async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'userId is required.' });
  }

  const children = await db.all('SELECT * FROM children WHERE user_id = ? ORDER BY created_at DESC', userId);
  res.json({ success: true, children });
});

app.post('/api/children', async (req, res) => {
  const child = req.body;
  if (!child || !child.user_id || !child.full_name) {
    return res.status(400).json({ success: false, message: 'Child data is required.' });
  }

  const result = await db.run(
    `INSERT INTO children (
      user_id, full_name, age, gender, school, province, district,
      start_location, end_location, distance, phone_number, qr_code,
      magnetic_code, season_start_date, season_end_date, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    child.user_id,
    child.full_name,
    child.age,
    child.gender,
    child.school,
    child.province,
    child.district,
    child.start_location,
    child.end_location,
    child.distance,
    child.phone_number,
    child.qr_code,
    child.magnetic_code,
    child.season_start_date,
    child.season_end_date,
    child.status
  );

  const newChild = await db.get('SELECT * FROM children WHERE id = ?', result.lastID);
  res.status(201).json({ success: true, child: newChild });
});

app.get('/api/children/:id', async (req, res) => {
  const id = Number(req.params.id);
  const child = await db.get('SELECT * FROM children WHERE id = ?', id);
  if (!child) {
    return res.status(404).json({ success: false, message: 'Child not found.' });
  }
  res.json({ success: true, child });
});

app.delete('/api/children/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ success: false, message: 'userId is required.' });
  }

  const result = await db.run('DELETE FROM children WHERE id = ? AND user_id = ?', id, userId);
  if (result.changes === 0) {
    return res.status(404).json({ success: false, message: 'Child not found or permission denied.' });
  }

  await db.run('DELETE FROM trips WHERE child_id = ?', id);
  res.json({ success: true, message: 'Child removed.' });
});

app.get('/api/trips', async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'userId is required.' });
  }
  const trips = await db.all(
    'SELECT t.*, c.full_name AS child_name FROM trips t JOIN children c ON t.child_id = c.id WHERE t.user_id = ? ORDER BY t.created_at DESC',
    userId
  );
  res.json({ success: true, trips });
});

app.post('/api/trips', async (req, res) => {
  const { userId, code, tripType } = req.body;
  if (!userId || !code || !tripType) {
    return res.status(400).json({ success: false, message: 'userId, code, and tripType are required.' });
  }

  const child = await db.get(
    'SELECT * FROM children WHERE user_id = ? AND (qr_code = ? OR magnetic_code = ?)',
    userId,
    code,
    code
  );
  if (!child) {
    return res.status(404).json({ success: false, message: 'Child code not found.' });
  }

  const now = new Date();
  const tripDate = now.toISOString().slice(0, 10);
  const tripTime = now.toTimeString().slice(0, 8);

  const existingTrips = await db.get(
    'SELECT COUNT(*) as tripCount FROM trips WHERE child_id = ? AND trip_date = ?',
    child.id,
    tripDate
  );

  const tripCount = existingTrips?.tripCount || 0;
  console.log(`Child ${child.id} has ${tripCount} trips on ${tripDate}`);

  if (tripCount >= 2) {
    const errorMsg = `This child has already been marked ${tripCount} times today. Maximum is 2 marks per day.`;
    console.log(`Blocking trip - error: ${errorMsg}`);
    return res.status(400).json({ success: false, message: errorMsg });
  }

  const result = await db.run(
    'INSERT INTO trips (user_id, child_id, trip_date, trip_time, trip_type) VALUES (?, ?, ?, ?, ?)',
    userId,
    child.id,
    tripDate,
    tripTime,
    tripType
  );

  const trip = await db.get(
    'SELECT t.*, c.full_name AS child_name FROM trips t JOIN children c ON t.child_id = c.id WHERE t.id = ?',
    result.lastID
  );
  res.status(201).json({ success: true, trip });
});

app.get('/api/ping', (req, res) => {
  res.json({ success: true, message: 'pong' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
