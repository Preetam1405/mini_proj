'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');
const { addDays } = require('./util');
const { openMysqlDb } = require('./mysql-sync');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
  pw_hash TEXT,
  google_sub TEXT,
  dept TEXT,
  gender TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dept TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'regular' CHECK (type IN ('regular', 'visiting')),
  availability TEXT NOT NULL DEFAULT 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  age INTEGER,
  sex TEXT,
  phone TEXT,
  allergy TEXT NOT NULL DEFAULT 'None known',
  cond TEXT NOT NULL DEFAULT 'Outpatient',
  bed TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vitals (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  bp TEXT NOT NULL, hr INTEGER NOT NULL, temp REAL NOT NULL, spo2 INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Booked' CHECK (status IN ('Booked','Checked in','Completed','Cancelled')),
  cancel_reason TEXT NOT NULL DEFAULT '',
  is_emergency INTEGER NOT NULL DEFAULT 0,
  emergency_notes TEXT NOT NULL DEFAULT '',
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_slot ON appointments(doctor_id, date, time) WHERE status != 'Cancelled';
CREATE INDEX IF NOT EXISTS ix_appt_date ON appointments(date);

CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  drug TEXT NOT NULL, dose TEXT NOT NULL, days INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doctor_leaves (
  id INTEGER PRIMARY KEY,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doctor_id, date)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('1_day_before', 'day_of', '1_hour_before', 'missed', 'emergency_delay')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  \`read\` INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(appointment_id, type)
);

CREATE TABLE IF NOT EXISTS doctor_timing_extensions (
  id INTEGER PRIMARY KEY,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  extension_minutes INTEGER NOT NULL DEFAULT 25,
  original_end_time TEXT NOT NULL DEFAULT '17:00',
  extended_end_time TEXT NOT NULL DEFAULT '17:25',
  emergency_count INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT 'Emergency patient case',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doctor_id, date)
);

CREATE TABLE IF NOT EXISTS doctor_notifications (
  id INTEGER PRIMARY KEY,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'emergency_alert',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  \`read\` INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const SCHEMA_MYSQL = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role ENUM('patient','doctor','admin') NOT NULL,
  pw_hash VARCHAR(255),
  google_sub VARCHAR(255),
  dept VARCHAR(255),
  gender VARCHAR(20),
  status ENUM('active','pending','disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY ux_users_email (email)
);

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INT NOT NULL,
  expires_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS doctors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNIQUE,
  name VARCHAR(255) NOT NULL,
  dept VARCHAR(255) NOT NULL,
  type ENUM('regular', 'visiting') NOT NULL DEFAULT 'regular',
  availability VARCHAR(255) NOT NULL DEFAULT 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS patients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNIQUE,
  name VARCHAR(255) NOT NULL,
  age INT,
  sex VARCHAR(50),
  phone VARCHAR(50),
  allergy VARCHAR(255) NOT NULL DEFAULT 'None known',
  cond VARCHAR(255) NOT NULL DEFAULT 'Outpatient',
  bed VARCHAR(50) UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS vitals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  \`at\` VARCHAR(50) NOT NULL,
  bp VARCHAR(50) NOT NULL,
  hr INT NOT NULL,
  temp DOUBLE NOT NULL,
  spo2 INT NOT NULL,
  user_id INT,
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  doctor_id INT NOT NULL,
  date VARCHAR(50) NOT NULL,
  time VARCHAR(50) NOT NULL,
  status ENUM('Booked','Checked in','Completed','Cancelled') NOT NULL DEFAULT 'Booked',
  cancel_reason VARCHAR(255) NOT NULL DEFAULT '',
  is_emergency INT NOT NULL DEFAULT 0,
  emergency_notes VARCHAR(255) NOT NULL DEFAULT '',
  delay_minutes INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX ix_appt_date (date),
  INDEX ix_appt_slot (doctor_id, date, time),
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  doctor_id INT NOT NULL,
  drug VARCHAR(255) NOT NULL,
  dose VARCHAR(255) NOT NULL,
  days INT NOT NULL,
  notes VARCHAR(255) NOT NULL DEFAULT '',
  date VARCHAR(50) NOT NULL,
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS doctor_leaves (
  id INT AUTO_INCREMENT PRIMARY KEY,
  doctor_id INT NOT NULL,
  date VARCHAR(50) NOT NULL,
  reason VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY ux_doc_leave (doctor_id, date),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  appointment_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  \`read\` INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY ux_notif (appointment_id, type),
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS doctor_timing_extensions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  doctor_id INT NOT NULL,
  date VARCHAR(50) NOT NULL,
  extension_minutes INT NOT NULL DEFAULT 25,
  original_end_time VARCHAR(20) NOT NULL DEFAULT '17:00',
  extended_end_time VARCHAR(20) NOT NULL DEFAULT '17:25',
  emergency_count INT NOT NULL DEFAULT 1,
  reason VARCHAR(255) NOT NULL DEFAULT 'Emergency patient case',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY ux_doc_ext (doctor_id, date),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS doctor_notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  doctor_id INT NOT NULL,
  appointment_id INT,
  type VARCHAR(50) NOT NULL DEFAULT 'emergency_alert',
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  \`read\` INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL
);
`;

function ensureEmergencySchema(db) {
  if (db.isMysql) {
    try { db.exec('ALTER TABLE users ADD COLUMN gender VARCHAR(20)'); } catch {}
    try { db.exec('ALTER TABLE appointments ADD COLUMN is_emergency INT NOT NULL DEFAULT 0'); } catch {}
    try { db.exec("ALTER TABLE appointments ADD COLUMN emergency_notes VARCHAR(255) NOT NULL DEFAULT ''"); } catch {}
    try { db.exec('ALTER TABLE appointments ADD COLUMN delay_minutes INT NOT NULL DEFAULT 0'); } catch {}
    try { db.exec('ALTER TABLE notifications MODIFY COLUMN type VARCHAR(50) NOT NULL'); } catch {}
  } else {
    try { db.exec('ALTER TABLE users ADD COLUMN gender TEXT'); } catch {}
    try { db.exec('ALTER TABLE appointments ADD COLUMN is_emergency INTEGER NOT NULL DEFAULT 0'); } catch {}
    try { db.exec("ALTER TABLE appointments ADD COLUMN emergency_notes TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec('ALTER TABLE appointments ADD COLUMN delay_minutes INTEGER NOT NULL DEFAULT 0'); } catch {}
  }
}

function openDb(fileOrOpts) {
  const isOpts = typeof fileOrOpts === 'object' && fileOrOpts !== null;
  const dbPath = isOpts ? fileOrOpts.dbPath : fileOrOpts;
  const forceDriver = process.env.DB_DRIVER || (isOpts ? fileOrOpts.driver : null);

  // If memory database is requested (e.g. for unit tests), always use SQLite
  if (dbPath === ':memory:' || forceDriver === 'sqlite') {
    const db = new DatabaseSync(dbPath || ':memory:');
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    ensureEmergencySchema(db);
    return db;
  }

  // Otherwise, default to XAMPP MySQL
  try {
    const mysqlDb = openMysqlDb(isOpts ? fileOrOpts : {});
    mysqlDb.exec(SCHEMA_MYSQL);
    ensureEmergencySchema(mysqlDb);
    console.log('Connected to XAMPP MySQL database: meridian_hospital');
    return mysqlDb;
  } catch (err) {
    if (forceDriver === 'mysql') throw err;
    console.warn(`XAMPP MySQL connection unavailable (${err.message}). Using SQLite: ${dbPath || 'data/meridian.db'}`);
    const filePath = dbPath || path.join(__dirname, '..', 'data', 'meridian.db');
    const db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    ensureEmergencySchema(db);
    return db;
  }
}

function tx(db, fn) {
  if (db.isMysql) {
    db.exec('START TRANSACTION');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Creates the first administrator when there is none. */
async function ensureAdmin(db, email, password, name = 'Administrator') {
  if (db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) return false;
  if (!email || !password) return false;
  db.prepare("INSERT INTO users(email,name,role,pw_hash,status) VALUES (?,?,?,?, 'active')").run(email, name, 'admin', await hashPassword(password));
  return true;
}

const DEMO_PASSWORD = 'Demo@12345';
const DEMO_USERS = {
  patient: 'patient@meridian.demo',
  doctor: 'doctor@meridian.demo',
  admin: 'admin@meridian.demo',
};

/** Loads sample hospital data and demo accounts. Only for development and demos. */
async function seedDemo(db, today) {
  if (db.prepare('SELECT 1 FROM patients LIMIT 1').get() || db.prepare('SELECT 1 FROM doctors LIMIT 1').get()) return false;
  const pw = await hashPassword(DEMO_PASSWORD);
  const U = db.prepare("INSERT INTO users(email,name,role,pw_hash,dept,status) VALUES (?,?,?,?,?, 'active')");
  const uid = (email, name, role, dept) => Number(U.run(email, name, role, pw, dept || null).lastInsertRowid);
  const patientUser = uid(DEMO_USERS.patient, 'Ananya Sharma', 'patient');
  const doctorUser = uid(DEMO_USERS.doctor, 'Dr. Meera Iyer', 'doctor', 'Cardiology');
  uid(DEMO_USERS.admin, 'Neha Verma', 'admin');

  tx(db, () => {
    const D = db.prepare('INSERT INTO doctors(user_id,name,dept,type,availability) VALUES (?,?,?,?,?)');
    D.run(doctorUser, 'Dr. Meera Iyer', 'Cardiology', 'regular', 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday');
    D.run(null, 'Dr. Arjun Nair', 'Orthopaedics', 'regular', 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday');
    D.run(null, 'Dr. Sunita Rao', 'General Medicine', 'regular', 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday');
    D.run(null, 'Dr. Farah Khan', 'Pediatrics', 'visiting', 'Monday,Wednesday,Friday');
    D.run(null, 'Dr. Rohan Mehta', 'Neurology', 'visiting', 'Tuesday,Thursday,Saturday');
    D.run(null, 'Dr. Kavya Menon', 'Gynaecology', 'visiting', 'Tuesday,Friday');

    const P = db.prepare('INSERT INTO patients(user_id,name,age,sex,phone,allergy,cond,bed) VALUES (?,?,?,?,?,?,?,?)');
    P.run(patientUser, 'Ananya Sharma', 34, 'F', '98450 11201', 'Penicillin', 'Post-operative recovery', 'G-04');
    P.run(null, 'Vikram Patel', 58, 'M', '98860 22340', 'None known', 'Chest pain, under monitoring', 'C-02');
    P.run(null, 'Lakshmi Devi', 71, 'F', '99000 33412', 'Sulfa drugs', 'Heart failure, stable', 'C-05');
    P.run(null, 'Imran Sheikh', 45, 'M', '97411 44523', 'None known', 'Outpatient', null);
    P.run(null, 'Rhea Kapoor', 7, 'F', '98450 55634', 'None known', 'Viral fever', 'P-01');
    P.run(null, 'Suresh Kumar', 63, 'M', '98860 66745', 'None known', 'Post-stroke rehabilitation', 'N-03');
    P.run(null, 'Divya Nair', 29, 'F', '99000 77856', 'Latex', 'Outpatient', null);
    P.run(null, 'Joseph Mathew', 52, 'M', '97411 88967', 'None known', 'Knee replacement, day 2', 'O-02');

    const V = db.prepare('INSERT INTO vitals(patient_id,at,bp,hr,temp,spo2) VALUES (?,?,?,?,?,?)');
    [[1, '08:10', '118/76', 78, 36.8, 98], [2, '08:00', '146/92', 96, 37.1, 95], [3, '08:05', '132/80', 84, 36.6, 93],
     [5, '07:50', '98/62', 104, 38.2, 97], [6, '08:20', '140/88', 72, 36.7, 96], [8, '08:15', '128/84', 80, 37.0, 97]]
      .forEach(([p, t, bp, hr, temp, o2]) => V.run(p, `${today} ${t}`, bp, hr, temp, o2));

    const A = db.prepare('INSERT INTO appointments(patient_id,doctor_id,date,time,status) VALUES (?,?,?,?,?)');
    A.run(4, 3, today, '09:30', 'Checked in');
    A.run(7, 6, today, '10:00', 'Booked');
    A.run(2, 1, today, '11:30', 'Booked');
    A.run(1, 3, today, '16:00', 'Booked');
    A.run(1, 4, addDays(today, 1), '14:30', 'Booked');
    A.run(1, 1, addDays(today, 2), '10:30', 'Booked');
    A.run(5, 4, today, '14:00', 'Booked');
    A.run(8, 2, addDays(today, 1), '12:00', 'Booked');

    const R = db.prepare('INSERT INTO prescriptions(patient_id,doctor_id,drug,dose,days,notes,date) VALUES (?,?,?,?,?,?,?)');
    R.run(1, 1, 'Paracetamol 500 mg', '1 tablet, three times a day', 5, 'After meals', addDays(today, -1));
    R.run(2, 1, 'Atorvastatin 20 mg', '1 tablet at night', 30, '', addDays(today, -3));
    R.run(1, 3, 'Vitamin D3 60000 IU', '1 sachet weekly', 8, 'With milk', addDays(today, -6));
  });
  return true;
}

module.exports = { openDb, tx, ensureAdmin, seedDemo, DEMO_USERS, DEMO_PASSWORD };
