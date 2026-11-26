'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { openDb, tx, ensureAdmin, seedDemo, DEMO_USERS, DEMO_PASSWORD } = require('./db');
const auth = require('./auth');
const { HttpError, bad, v, DEPTS, WARDS, SLOTS, allBeds, patientCode, parsePatientCode, nowIn, addDays, dayOfWeek, oneHourBefore, addMinutesToTime } = require('./util');

const STAFF_ROLES = ['doctor'];
const ALL_ROLES = ['patient', 'doctor', 'admin'];
const CLINICAL = ['doctor', 'admin'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function createApp(opts = {}) {
  const env = process.env;
  const cfg = {
    dbPath: opts.dbPath ?? env.DB_PATH ?? path.join(__dirname, '..', 'data', 'meridian.db'),
    publicDir: opts.publicDir ?? path.join(__dirname, '..', 'public'),
    tz: opts.tz ?? env.HOSPITAL_TZ ?? 'Asia/Kolkata',
    production: opts.production ?? env.NODE_ENV === 'production',
    googleClientId: opts.googleClientId ?? env.GOOGLE_CLIENT_ID ?? '',
    verifyGoogle: opts.verifyGoogle ?? auth.verifyGoogleIdToken,
    cookieSecure: opts.cookieSecure ?? env.COOKIE_SECURE === '1',
    adminEmail: opts.adminEmail ?? env.ADMIN_EMAIL ?? '',
    adminPassword: opts.adminPassword ?? env.ADMIN_PASSWORD ?? '',
    demo: opts.demo ?? (env.DEMO_MODE != null ? env.DEMO_MODE === '1' : env.NODE_ENV !== 'production'),
    now: opts.now ?? null,
  };
  if (cfg.dbPath !== ':memory:') fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const db = openDb(cfg.dbPath);
  const now = () => (cfg.now ? cfg.now() : nowIn(cfg.tz));
  const loginLimiter = auth.makeLimiter(8, 15 * 60 * 1000);

  const ready = (async () => {
    await ensureAdmin(db, cfg.adminEmail, cfg.adminPassword);
    if (cfg.demo) {
      await seedDemo(db, now().date);
      await ensureAdmin(db, DEMO_USERS.admin, DEMO_PASSWORD, 'Neha Verma');
    }
  })();

  /* ------------------------------------------------------------ helpers */
  const patientOut = (r) => ({
    id: patientCode(r.id), name: r.name, age: r.age, sex: r.sex, phone: r.phone,
    allergy: r.allergy, cond: r.cond, bed: r.bed,
    latest: !r.latest ? null : (typeof r.latest === 'object' ? r.latest : JSON.parse(r.latest)),
  });
  const PATIENT_SQL = `SELECT p.*, (SELECT json_object('at', at, 'bp', bp, 'hr', hr, 'temp', temp, 'spo2', spo2)
                       FROM vitals v WHERE v.patient_id = p.id ORDER BY v.id DESC LIMIT 1) AS latest FROM patients p`;
  const patientRowByUser = (userId) => db.prepare('SELECT * FROM patients WHERE user_id = ?').get(userId);
  function patientByCode(code) {
    const id = parsePatientCode(code);
    const row = id && db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
    if (!row) throw bad('Unknown patient number.');
    return row;
  }
  const doctorRowByUser = (userId) => db.prepare('SELECT * FROM doctors WHERE user_id = ?').get(userId);

  const APPT_SQL = `SELECT a.id, a.date, a.time, a.status, a.cancel_reason, a.is_emergency, a.emergency_notes, a.delay_minutes, a.patient_id, a.doctor_id,
      p.name AS patient_name, d.name AS doctor_name, d.dept AS dept, d.type AS doctor_type
    FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id`;
  const apptOut = (r) => {
    const n = now();
    const apptDateTime = new Date(`${r.date}T${r.time}:00Z`).getTime();
    const currentDateTime = new Date(`${n.date}T${n.time}:00Z`).getTime();
    const minsUntil = Math.round((apptDateTime - currentDateTime) / (60 * 1000));
    const reminders = [
      {
        type: '1_day_before',
        label: '1 Day Before',
        when: addDays(r.date, -1),
        status: (n.date > addDays(r.date, -1) || (n.date === addDays(r.date, -1) && n.time >= '09:00')) ? 'sent' : (n.date === addDays(r.date, -1) ? 'active' : 'scheduled'),
      },
      {
        type: 'day_of',
        label: 'Day of Appointment',
        when: `${r.date} morning`,
        status: (n.date > r.date || (n.date === r.date && n.time >= '08:00')) ? 'sent' : (n.date === r.date ? 'active' : 'scheduled'),
      },
      {
        type: '1_hour_before',
        label: '1 Hour Before',
        when: `${r.date} at ${oneHourBefore(r.time)}`,
        status: (minsUntil <= 60 && minsUntil >= 0) ? 'active' : (minsUntil < 0 ? 'sent' : 'scheduled'),
      },
    ];
    return {
      id: r.id, date: r.date, time: r.time, status: r.status, cancelReason: r.cancel_reason || '',
      patientId: patientCode(r.patient_id), patientName: r.patient_name, doctorId: r.doctor_id,
      doctorName: r.doctor_name, dept: r.dept, doctorType: r.doctor_type || 'regular', reminders,
      isEmergency: !!r.is_emergency,
      emergencyNotes: r.emergency_notes || '',
      delayMinutes: Number(r.delay_minutes || 0),
    };
  };
  const rxOut = (r) => ({
    id: r.id, patientId: patientCode(r.patient_id), patientName: r.patient_name, doctorId: r.doctor_id,
    doctorName: r.doctor_name, drug: r.drug, dose: r.dose, days: r.days, notes: r.notes, date: r.date,
  });
  const RX_SQL = `SELECT r.*, p.name AS patient_name, d.name AS doctor_name FROM prescriptions r
    JOIN patients p ON p.id = r.patient_id JOIN doctors d ON d.id = r.doctor_id`;

  function normalizeGender(raw) {
    const val = String(raw || '').trim();
    const map = { F: 'F', Female: 'F', female: 'F', M: 'M', Male: 'M', male: 'M', Other: 'Other', other: 'Other' };
    if (!map[val]) throw bad('Gender must be Female, Male, or Other.');
    return map[val];
  }

  function loginUser(res, user) {
    const s = auth.createSession(db, user.id);
    res.cookie = `mh_session=${s.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${s.maxAge}${cfg.cookieSecure ? '; Secure' : ''}`;
    let doctorType = null;
    if (user.role === 'doctor') {
      const d = doctorRowByUser(user.id);
      if (d) doctorType = d.type;
    }
    return { id: user.id, name: user.name, email: user.email, role: user.role, gender: user.gender || null, doctorType };
  }

  /** Creates the account and its linked records. Staff accounts wait for an administrator. */
  function createAccount({ email, name, role, pwHash, googleSub, dept, type, availability, gender, age, phone }) {
    const status = (role === 'patient' || role === 'admin') ? 'active' : 'pending';
    return tx(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email is already registered. Sign in instead.');
      const id = Number(
        db.prepare('INSERT INTO users(email,name,role,pw_hash,google_sub,dept,gender,status) VALUES (?,?,?,?,?,?,?,?)')
          .run(email, name, role, pwHash || null, googleSub || null, role === 'doctor' ? dept : null, gender || null, status).lastInsertRowid
      );
      if (role === 'patient') {
        db.prepare('INSERT INTO patients(user_id,name,age,sex,phone) VALUES (?,?,?,?,?)')
          .run(id, name, age ?? null, gender || null, phone || null);
      }
      if (role === 'doctor') {
        const docType = type || 'regular';
        const docAvail = type === 'visiting'
          ? (availability || 'Monday')
          : 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday';
        db.prepare('INSERT INTO doctors(user_id,name,dept,type,availability) VALUES (?,?,?,?,?)').run(
          id, /^dr\.?\s/i.test(name) ? name : 'Dr. ' + name, dept, docType, docAvail
        );
      }
      return { id, email, name, role, gender: gender || null, status };
    });
  }

  function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) out[k] = decodeURIComponent(v.join('='));
    }
    return out;
  }

  /**
   * Automatically checks for any booked appointments whose scheduled date/time has passed
   * without the patient checking in. Updates their status to 'Cancelled' (reason: 'Missed / No-show')
   * and notifies the patient so they can reschedule.
   */
  function autoCancelMissedAppointments() {
    const n = now();
    const missed = db.prepare(
      `SELECT a.id, a.patient_id, a.doctor_id, a.date, a.time, d.name AS doctor_name, d.dept
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id
       WHERE a.status = 'Booked' AND (a.date < ? OR (a.date = ? AND a.time < ?))`
    ).all(n.date, n.date, n.time);

    if (missed.length) {
      for (const a of missed) {
        db.prepare("UPDATE appointments SET status = 'Cancelled', cancel_reason = 'Missed / No-show' WHERE id = ?").run(a.id);
        db.prepare(
          `INSERT OR IGNORE INTO notifications(patient_id, appointment_id, type, title, message)
           VALUES (?, ?, 'missed', ?, ?)`
        ).run(
          a.patient_id,
          a.id,
          'Appointment Missed & Cancelled',
          `Your appointment with ${a.doctor_name} (${a.dept}) scheduled for ${a.date} at ${a.time} was missed and has been automatically cancelled. You can reschedule your visit anytime.`
        );
      }
    }
    return missed;
  }

  /* ------------------------------------------------------------ routes */
  const routes = [];
  function route(method, pathStr, roles, handler) {
    const keys = [];
    const pattern = new RegExp(
      '^' +
      pathStr.replace(/:([a-zA-Z0-9_]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$'
    );
    routes.push({ method, pattern, keys, roles, handler });
  }

  const reply = (status, body) => ({ status, body });

  route('GET', '/api/config', null, () => ({
    googleClientId: cfg.googleClientId || null,
    today: now().date,
    time: now().time,
    depts: DEPTS,
  }));

  route('POST', '/api/auth/register', null, async ({ body, res }) => {
    const role = v.oneOf(body.role, 'Role', ALL_ROLES);
    const name = v.str(body.name, 'Full name', { max: 100 });
    const email = v.email(body.email);
    const pw = v.password(body.password);
    const rawGender = body.gender !== undefined ? body.gender : body.sex;
    const gender = (rawGender != null && rawGender !== '') ? normalizeGender(rawGender) : null;
    const age = (role === 'patient' && body.age != null && body.age !== '') ? v.int(body.age, 'Age', 0, 120) : null;
    const phone = (role === 'patient' && body.phone != null && body.phone !== '') ? v.str(body.phone, 'Phone number', { min: 3, max: 30 }) : null;
    const dept = role === 'doctor' ? v.oneOf(body.dept, 'Department', DEPTS) : null;
    const type = role === 'doctor' ? v.oneOf(body.type || 'regular', 'Doctor type', ['regular', 'visiting']) : null;
    const rawAvail = role === 'doctor' && body.type === 'visiting' ? body.availability : null;
    const availability = rawAvail
      ? (Array.isArray(rawAvail) ? rawAvail : String(rawAvail).split(',')).filter(d => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(d)).join(',') || null
      : null;
    if (role === 'doctor' && body.type === 'visiting' && !availability) throw bad('Select at least one available day for a visiting doctor.');
    const user = createAccount({ email, name, role, pwHash: await auth.hashPassword(pw), dept, type, availability, gender, age, phone });
    if (user.status === 'pending') return reply(202, { pending: true, message: 'Account created. An administrator must approve it before you can sign in.' });
    return reply(201, { user: loginUser(res, user) });
  });

  route('POST', '/api/auth/login', null, async ({ body, res, ip }) => {
    const email = v.email(body.email);
    const role = v.oneOf(body.role, 'Role', ALL_ROLES);
    const key = ip + '|' + email;
    if (!loginLimiter.check(key)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = await auth.verifyPassword(typeof body.password === 'string' ? body.password : '', user && user.pw_hash);
    if (!user || !ok) {
      loginLimiter.fail(key);
      if (user && !user.pw_hash && user.google_sub) throw new HttpError(401, 'This account uses Google. Choose Continue with Google.');
      throw new HttpError(401, 'Wrong email or password.');
    }
    loginLimiter.clear(key);
    if (user.role !== role) throw new HttpError(403, `This email belongs to a ${user.role} account. Go back and choose that role.`);
    if (user.status === 'pending') throw new HttpError(403, 'Your account is waiting for administrator approval.');
    if (user.status === 'disabled') throw new HttpError(403, 'This account has been disabled. Contact the administrator.');
    return { user: loginUser(res, user) };
  });

  route('POST', '/api/auth/google', null, async ({ body, res }) => {
    const role = v.oneOf(body.role, 'Role', ALL_ROLES);
    let g;
    if (cfg.googleClientId) {
      try {
        g = await cfg.verifyGoogle(v.str(body.credential, 'Google credential', { max: 5000 }), cfg.googleClientId);
      } catch (e) {
        throw new HttpError(401, e.message || 'Google sign-in failed.');
      }
    } else {
      // Local or development Google authentication when GOOGLE_CLIENT_ID is not configured
      const cred = v.str(body.credential, 'Google credential', { max: 5000 });
      let email, name, sub;
      if (cred.includes('|')) {
        const parts = cred.split('|');
        email = parts[0];
        name = parts[1];
        sub = parts[2] || ('g_' + auth.sha(email).slice(0, 16));
      } else {
        email = cred;
        name = cred.split('@')[0];
        sub = 'g_' + auth.sha(email).slice(0, 16);
      }
      email = v.email(email);
      name = v.str(name || email.split('@')[0], 'Name', { max: 100 });
      g = { sub, email, name };
    }
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(g.email);
    if (!user) {
      const dept = role === 'doctor' ? v.oneOf(body.dept || 'General Medicine', 'Department', DEPTS) : null;
      const gType = role === 'doctor' ? v.oneOf(body.type || 'regular', 'Doctor type', ['regular', 'visiting']) : null;
      const gRawAvail = role === 'doctor' && body.type === 'visiting' ? body.availability : null;
      const gAvail = gRawAvail
        ? (Array.isArray(gRawAvail) ? gRawAvail : String(gRawAvail).split(',')).filter(d => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(d)).join(',') || null
        : null;
      user = createAccount({ email: g.email, name: g.name, role, googleSub: g.sub, dept, type: gType, availability: gAvail });
      if (user.status === 'pending') return reply(202, { pending: true, message: 'Account created. An administrator must approve it before you can sign in.' });
    } else {
      if (user.google_sub && user.google_sub !== g.sub) throw new HttpError(401, 'This email is linked to a different Google account.');
      if (user.role !== role) throw new HttpError(403, `This email belongs to a ${user.role} account. Go back and choose that role.`);
      if (user.status === 'pending') throw new HttpError(403, 'Your account is waiting for administrator approval.');
      if (user.status === 'disabled') throw new HttpError(403, 'This account has been disabled. Contact the administrator.');
      if (!user.google_sub) db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(g.sub, user.id);
    }
    return { user: loginUser(res, user) };
  });

  route('POST', '/api/auth/logout', null, ({ res, token }) => {
    auth.destroySession(db, token);
    res.cookie = `mh_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cfg.cookieSecure ? '; Secure' : ''}`;
    return { ok: true };
  });

  route('GET', '/api/me', ALL_ROLES, ({ user }) => {
    let doctorType = null;
    if (user.role === 'doctor') {
      const d = doctorRowByUser(user.id);
      if (d) doctorType = d.type;
    }
    return { user: { ...user, doctorType } };
  });

  route('GET', '/api/doctors', ALL_ROLES, () =>
    db
      .prepare(
        `SELECT d.id, d.name, d.dept, d.type, d.availability FROM doctors d LEFT JOIN users u ON u.id = d.user_id
         WHERE u.id IS NULL OR u.status = 'active' ORDER BY d.type, d.name`
      )
      .all()
  );

  route('GET', '/api/slots', ALL_ROLES, ({ query }) => {
    const doctorId = v.int(query.doctor, 'Doctor', 1, 1e9);
    const date = v.date(query.date);
    const doc = db.prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId);
    if (!doc) throw bad('Doctor not found.');

    const docDay = dayOfWeek(date);
    const availableDays = doc.availability ? doc.availability.split(',').map((s) => s.trim()) : [];
    const isAvailableOnDay = availableDays.includes(docDay);

    if (!isAvailableOnDay) {
      return {
        doctorId,
        date,
        dayOfWeek: docDay,
        doctorType: doc.type,
        availableDays,
        slots: [],
        message: `${doc.name} is a visiting doctor and is not available on ${docDay}s. Available on: ${availableDays.join(', ')}.`
      };
    }

    const onLeave = !!db.prepare('SELECT 1 FROM doctor_leaves WHERE doctor_id = ? AND date = ?').get(doctorId, date);
    if (onLeave) {
      return {
        doctorId, date, dayOfWeek: docDay, doctorType: doc.type, availableDays, slots: [], onLeave: true,
        message: `${doc.name} is on leave on ${date}. Please choose another available date.`
      };
    }

    const n = now();
    const taken = new Set(
      db.prepare("SELECT time FROM appointments WHERE doctor_id = ? AND date = ? AND status != 'Cancelled'").all(doctorId, date).map((r) => r.time)
    );
    const slots = SLOTS.filter((t) => !taken.has(t) && !(date === n.date && t <= n.time) && !(date < n.date));
    return { doctorId, date, dayOfWeek: docDay, doctorType: doc.type, availableDays, slots };
  });

  /* ---- appointments */
  route('GET', '/api/appointments', ALL_ROLES, ({ user, query }) => {
    let rows;
    if (user.role === 'patient') {
      const p = patientRowByUser(user.id);
      rows = p ? db.prepare(APPT_SQL + ' WHERE a.patient_id = ? ORDER BY a.date, a.time').all(p.id) : [];
    } else if (user.role === 'doctor') {
      const d = doctorRowByUser(user.id);
      rows = d ? db.prepare(APPT_SQL + ' WHERE a.doctor_id = ? ORDER BY a.date, a.time').all(d.id) : [];
    } else {
      const from = query.from ? v.date(query.from, 'From') : now().date;
      rows = db.prepare(APPT_SQL + ' WHERE a.date >= ? ORDER BY a.date, a.time').all(from);
    }
    return rows.map(apptOut);
  });

  route('POST', '/api/appointments', ['patient', 'admin'], ({ user, body }) => {
    let patient;
    if (user.role === 'patient') {
      patient = patientRowByUser(user.id);
      if (!patient) throw bad('No patient record is linked to your account.');
    } else patient = patientByCode(body.patientId);
    const doctorId = v.int(body.doctorId, 'Doctor', 1, 1e9);
    const doc = db.prepare(`SELECT d.id, d.name, d.availability FROM doctors d LEFT JOIN users u ON u.id = d.user_id
                            WHERE d.id = ? AND (u.id IS NULL OR u.status = 'active')`).get(doctorId);
    if (!doc) throw bad('Unknown doctor.');
    const date = v.date(body.date);

    const docDay = dayOfWeek(date);
    const availableDays = doc.availability ? doc.availability.split(',').map((s) => s.trim()) : [];
    if (availableDays.length && !availableDays.includes(docDay)) {
      throw bad(`${doc.name} is not available on ${docDay}s. Available on: ${availableDays.join(', ')}.`);
    }
    if (db.prepare('SELECT 1 FROM doctor_leaves WHERE doctor_id = ? AND date = ?').get(doctorId, date)) {
      throw bad(`${doc.name} is on leave on ${date}.`);
    }

    const time = v.oneOf(body.time, 'Time', SLOTS);
    const n = now();
    if (date < n.date || (date === n.date && time <= n.time)) throw bad('Pick a time that has not passed.');
    try {
      const id = Number(db.prepare('INSERT INTO appointments(patient_id,doctor_id,date,time) VALUES (?,?,?,?)').run(patient.id, doctorId, date, time).lastInsertRowid);
      return reply(201, apptOut(db.prepare(APPT_SQL + ' WHERE a.id = ?').get(id)));
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'That time was just taken. Pick another slot.');
      throw e;
    }
  });

  route('POST', '/api/appointments/emergency', ['patient', 'admin'], ({ user, body }) => {
    let patient;
    if (user.role === 'patient') {
      patient = patientRowByUser(user.id);
      if (!patient) throw bad('No patient record is linked to your account.');
    } else {
      if (body.patientId) {
        patient = patientByCode(body.patientId);
        if (!patient) throw bad('Patient not found.');
      } else if (body.name && body.phone) {
        const ptName = v.str(body.name, 'Patient name', { max: 100 });
        const ptAge = body.age != null && body.age !== '' ? v.int(body.age, 'Age', 0, 120) : null;
        const ptSex = body.sex ? v.oneOf(body.sex, 'Sex', ['F', 'M', 'Other']) : null;
        const ptPhone = v.str(body.phone, 'Phone', { min: 3, max: 30 });
        const ptAllergy = v.optStr(body.allergy, 'Allergies', 200) || 'None known';
        const newPtId = Number(
          db.prepare('INSERT INTO patients(name, age, sex, phone, allergy, cond) VALUES (?,?,?,?,?,?)')
            .run(ptName, ptAge, ptSex, ptPhone, ptAllergy, 'Emergency Outpatient').lastInsertRowid
        );
        patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(newPtId);
      } else {
        throw bad('Select an existing patient or provide walk-in patient details (name and phone).');
      }
    }

    const doctorId = v.int(body.doctorId, 'Doctor', 1, 1e9);
    const doc = db.prepare(
      `SELECT d.id, d.name, d.dept, d.type, d.availability
       FROM doctors d LEFT JOIN users u ON u.id = d.user_id
       WHERE d.id = ? AND (u.id IS NULL OR u.status = 'active')`
    ).get(doctorId);
    if (!doc) throw bad('Unknown doctor.');

    const n = now();
    const date = n.date;
    const docDay = dayOfWeek(date);
    const availableDays = doc.availability ? doc.availability.split(',').map((s) => s.trim()) : [];
    if (availableDays.length && !availableDays.includes(docDay)) {
      throw bad(`${doc.name} is not available on ${docDay}s. Available on: ${availableDays.join(', ')}.`);
    }
    if (db.prepare('SELECT 1 FROM doctor_leaves WHERE doctor_id = ? AND date = ?').get(doctorId, date)) {
      throw bad(`${doc.name} is on leave today.`);
    }

    let emergencyTime = (body.time && /^\d{2}:\d{2}$/.test(body.time)) ? body.time : n.time;
    if (emergencyTime < '09:00') emergencyTime = '09:00';

    return tx(db, () => {
      // Find the next upcoming booked appointment(s) for this doctor today
      const upcoming = db.prepare(
        `SELECT a.id, a.patient_id, a.doctor_id, a.date, a.time, a.delay_minutes, p.name AS patient_name
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.doctor_id = ? AND a.date = ? AND a.status = 'Booked' AND a.time >= ?
         ORDER BY a.time ASC`
      ).all(doctorId, date, emergencyTime);

      const delayedList = [];
      if (upcoming.length > 0) {
        // Shift in reverse (descending order) to avoid collisions
        const toShift = [...upcoming].reverse();
        for (const appt of toShift) {
          const shiftedTime = addMinutesToTime(appt.time, 20);
          db.prepare('UPDATE appointments SET time = ?, delay_minutes = delay_minutes + 20 WHERE id = ?')
            .run(shiftedTime, appt.id);
          db.prepare("DELETE FROM notifications WHERE appointment_id = ? AND type = 'emergency_delay'")
            .run(appt.id);
          db.prepare(
            `INSERT INTO notifications(patient_id, appointment_id, type, title, message)
             VALUES (?, ?, 'emergency_delay', ?, ?)`
          ).run(
            appt.patient_id,
            appt.id,
            '⚠️ Appointment Delayed by 20 Minutes',
            `Due to an urgent incoming emergency case with ${doc.name} (${doc.dept}), your appointment today has been adjusted and delayed by 20 minutes to ${shiftedTime}. We apologize for the inconvenience and appreciate your patience.`
          );
          delayedList.push({
            id: appt.id,
            patientName: appt.patient_name,
            originalTime: appt.time,
            newTime: shiftedTime,
            delayedMinutes: 20,
          });
        }
      }

      const emergencyNotes = v.optStr(body.notes || body.reason || 'Urgent emergency consultation (on the way to hospital)', 'Emergency notes', 255);
      const newApptId = Number(
        db.prepare(
          `INSERT INTO appointments(patient_id, doctor_id, date, time, status, is_emergency, emergency_notes, delay_minutes)
           VALUES (?, ?, ?, ?, 'Booked', 1, ?, 0)`
        ).run(patient.id, doctorId, date, emergencyTime, emergencyNotes).lastInsertRowid
      );

      // Doctor's daily timing extension: 25 minutes
      const existingExt = db.prepare('SELECT * FROM doctor_timing_extensions WHERE doctor_id = ? AND date = ?').get(doctorId, date);
      let extMins = 25;
      let extendedEndTime = '17:25';
      if (existingExt) {
        extMins = existingExt.extension_minutes + 25;
        extendedEndTime = addMinutesToTime(existingExt.extended_end_time, 25);
        db.prepare(
          `UPDATE doctor_timing_extensions
           SET extension_minutes = ?, extended_end_time = ?, emergency_count = emergency_count + 1
           WHERE id = ?`
        ).run(extMins, extendedEndTime, existingExt.id);
      } else {
        db.prepare(
          `INSERT INTO doctor_timing_extensions(doctor_id, date, extension_minutes, original_end_time, extended_end_time, emergency_count, reason)
           VALUES (?, ?, 25, '17:00', '17:25', 1, ?)`
        ).run(doctorId, date, `Emergency: ${emergencyNotes}`);
      }

      // Notify the doctor
      db.prepare(
        `INSERT INTO doctor_notifications(doctor_id, appointment_id, type, title, message)
         VALUES (?, ?, 'emergency_alert', ?, ?)`
      ).run(
        doctorId,
        newApptId,
        '🚨 Emergency Case Booked & Timing Extended',
        `Emergency patient ${patient.name} (${emergencyNotes}) has been booked for today at ${emergencyTime}. Your daily consultation timing has been extended by 25 minutes (until ${extendedEndTime}) to accommodate this urgent case.`
      );

      const createdAppt = apptOut(db.prepare(APPT_SQL + ' WHERE a.id = ?').get(newApptId));
      return reply(201, {
        appointment: createdAppt,
        delayedAppointments: delayedList,
        doctorExtension: {
          doctorId,
          date,
          extensionMinutes: extMins,
          originalEndTime: '17:00',
          extendedEndTime,
        },
        message: delayedList.length
          ? `Emergency slot booked at ${emergencyTime}. The next patient's slot was delayed by 20 minutes and notified. Doctor daily timing extended to ${extendedEndTime}.`
          : `Emergency slot booked at ${emergencyTime}. Doctor daily timing extended to ${extendedEndTime}.`,
      });
    });
  });

  route('POST', '/api/appointments/:id/reschedule', ['patient', 'admin'], ({ user, params, body }) => {
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(params.id));
    if (!a) throw new HttpError(404, 'Appointment not found.');
    if (user.role === 'patient') {
      const p = patientRowByUser(user.id);
      if (!p || p.id !== a.patient_id) throw new HttpError(403, 'That is not your appointment.');
    }
    if (!['Booked', 'Cancelled'].includes(a.status)) {
      throw new HttpError(409, 'Only booked or cancelled appointments can be rescheduled.');
    }
    const doctorId = body.doctorId ? v.int(body.doctorId, 'Doctor', 1, 1e9) : a.doctor_id;
    const doc = db.prepare(`SELECT d.id, d.name, d.availability FROM doctors d LEFT JOIN users u ON u.id = d.user_id
                            WHERE d.id = ? AND (u.id IS NULL OR u.status = 'active')`).get(doctorId);
    if (!doc) throw bad('Doctor not found.');
    const date = v.date(body.date);
    const time = v.oneOf(body.time, 'Time', SLOTS);

    const docDay = dayOfWeek(date);
    const availableDays = doc.availability ? doc.availability.split(',').map((s) => s.trim()) : [];
    if (availableDays.length && !availableDays.includes(docDay)) {
      throw bad(`${doc.name} is not available on ${docDay}s. Available on: ${availableDays.join(', ')}.`);
    }
    if (db.prepare('SELECT 1 FROM doctor_leaves WHERE doctor_id = ? AND date = ?').get(doctorId, date)) {
      throw bad(`${doc.name} is on leave on that date.`);
    }

    const n = now();
    if (date < n.date || (date === n.date && time <= n.time)) {
      throw bad('Pick a time that has not passed.');
    }

    const conflict = db.prepare(
      "SELECT id FROM appointments WHERE doctor_id = ? AND date = ? AND time = ? AND status != 'Cancelled' AND id != ?"
    ).get(doctorId, date, time, a.id);
    if (conflict) {
      throw new HttpError(409, 'That time slot is already taken. Please pick another slot.');
    }

    db.prepare("UPDATE appointments SET doctor_id = ?, date = ?, time = ?, status = 'Booked', cancel_reason = '' WHERE id = ?")
      .run(doctorId, date, time, a.id);

    return apptOut(db.prepare(APPT_SQL + ' WHERE a.id = ?').get(a.id));
  });

  route('PATCH', '/api/appointments/:id', ['patient', 'doctor', 'admin'], ({ user, params, body }) => {
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(params.id));
    if (!a) throw new HttpError(404, 'Appointment not found.');
    const status = v.oneOf(body.status, 'Status', ['Checked in', 'Completed', 'Cancelled']);
    const rules = {
      patient: { Cancelled: ['Booked'] },
      doctor: { Completed: ['Booked', 'Checked in'] },
      admin: { 'Checked in': ['Booked'], Cancelled: ['Booked', 'Checked in'], Completed: ['Booked', 'Checked in'] },
    };
    const allowedFrom = rules[user.role][status];
    if (!allowedFrom) throw new HttpError(403, 'Your role cannot make that change.');
    if (user.role === 'patient') {
      const p = patientRowByUser(user.id);
      if (!p || p.id !== a.patient_id) throw new HttpError(403, 'That is not your appointment.');
    }
    if (user.role === 'doctor') {
      const d = doctorRowByUser(user.id);
      if (!d || d.id !== a.doctor_id) throw new HttpError(403, 'That is not your appointment.');
    }
    if (!allowedFrom.includes(a.status)) throw new HttpError(409, `A ${a.status.toLowerCase()} appointment cannot be changed that way.`);
    const cancelReason = status === 'Cancelled' ? 'Cancelled by user' : '';
    db.prepare('UPDATE appointments SET status = ?, cancel_reason = ? WHERE id = ?').run(status, cancelReason, a.id);
    return apptOut(db.prepare(APPT_SQL + ' WHERE a.id = ?').get(a.id));
  });

  /* ---- patients */
  route('GET', '/api/patients/me', ['patient'], ({ user }) => {
    const row = patientRowByUser(user.id);
    if (!row) throw new HttpError(404, 'No patient record is linked to your account.');
    return patientOut(db.prepare(PATIENT_SQL + ' WHERE p.id = ?').get(row.id));
  });

  route('GET', '/api/patients', CLINICAL, () => db.prepare(PATIENT_SQL + ' ORDER BY p.id').all().map(patientOut));

  route('POST', '/api/patients', ['admin'], ({ body }) => {
    const id = Number(
      db.prepare('INSERT INTO patients(name,age,sex,phone,allergy) VALUES (?,?,?,?,?)').run(
        v.str(body.name, 'Name', { max: 100 }), v.int(body.age, 'Age', 0, 120), v.oneOf(body.sex, 'Sex', ['F', 'M', 'Other']),
        v.str(body.phone, 'Phone', { max: 30 }), v.optStr(body.allergy, 'Allergies', 200) || 'None known'
      ).lastInsertRowid
    );
    return reply(201, patientOut(db.prepare(PATIENT_SQL + ' WHERE p.id = ?').get(id)));
  });

  route('POST', '/api/patients/:code/admit', ['admin'], ({ params, body }) => {
    const p = patientByCode(params.code);
    const bed = v.oneOf(body.bed, 'Bed', allBeds());
    const cond = v.str(body.cond, 'Reason', { max: 200 });
    if (p.bed) throw new HttpError(409, 'That patient is already admitted.');
    try {
      db.prepare('UPDATE patients SET bed = ?, cond = ? WHERE id = ?').run(bed, cond, p.id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'That bed is already occupied.');
      throw e;
    }
    return patientOut(db.prepare(PATIENT_SQL + ' WHERE p.id = ?').get(p.id));
  });

  route('POST', '/api/patients/:code/discharge', ['admin'], ({ params }) => {
    const p = patientByCode(params.code);
    if (!p.bed) throw new HttpError(409, 'That patient is not admitted.');
    db.prepare("UPDATE patients SET bed = NULL, cond = 'Outpatient' WHERE id = ?").run(p.id);
    return patientOut(db.prepare(PATIENT_SQL + ' WHERE p.id = ?').get(p.id));
  });

  route('POST', '/api/patients/:code/vitals', ['doctor', 'admin'], ({ user, params, body }) => {
    const p = patientByCode(params.code);
    if (!p.bed) throw new HttpError(409, 'Vitals can only be recorded for admitted patients.');
    const bp = v.str(body.bp, 'Blood pressure', { max: 10 });
    if (!/^\d{2,3}\/\d{2,3}$/.test(bp)) throw bad('Blood pressure must look like 120/80.');
    const n = now();
    db.prepare('INSERT INTO vitals(patient_id,at,bp,hr,temp,spo2,user_id) VALUES (?,?,?,?,?,?,?)').run(
      p.id, `${n.date} ${n.time}`, bp, v.int(body.hr, 'Heart rate', 20, 250), v.num(body.temp, 'Temperature', 30, 43), v.int(body.spo2, 'SpO2', 50, 100), user.id
    );
    return reply(201, patientOut(db.prepare(PATIENT_SQL + ' WHERE p.id = ?').get(p.id)));
  });

  route('GET', '/api/beds', CLINICAL, () => {
    const occ = new Map(db.prepare('SELECT bed, name FROM patients WHERE bed IS NOT NULL').all().map((r) => [r.bed, r.name]));
    return Object.keys(WARDS).map((k) => ({
      key: k, name: WARDS[k].name, total: WARDS[k].total,
      beds: Array.from({ length: WARDS[k].total }, (_, i) => {
        const id = `${k}-${String(i + 1).padStart(2, '0')}`;
        return { id, patient: occ.get(id) || null };
      }),
    }));
  });

  /* ---- prescriptions */
  route('GET', '/api/prescriptions', ['patient', 'doctor', 'admin'], ({ user }) => {
    let rows;
    if (user.role === 'patient') {
      const p = patientRowByUser(user.id);
      rows = p ? db.prepare(RX_SQL + ' WHERE r.patient_id = ? ORDER BY r.date DESC, r.id DESC').all(p.id) : [];
    } else if (user.role === 'doctor') {
      const d = doctorRowByUser(user.id);
      rows = d ? db.prepare(RX_SQL + ' WHERE r.doctor_id = ? ORDER BY r.date DESC, r.id DESC').all(d.id) : [];
    } else rows = db.prepare(RX_SQL + ' ORDER BY r.date DESC, r.id DESC').all();
    return rows.map(rxOut);
  });

  route('POST', '/api/prescriptions', ['doctor'], ({ user, body }) => {
    const d = doctorRowByUser(user.id);
    if (!d) throw bad('No doctor record is linked to your account.');
    const p = patientByCode(body.patientId);
    const id = Number(
      db.prepare('INSERT INTO prescriptions(patient_id,doctor_id,drug,dose,days,notes,date) VALUES (?,?,?,?,?,?,?)').run(
        p.id, d.id, v.str(body.drug, 'Medicine', { max: 120 }), v.str(body.dose, 'How to take', { max: 160 }),
        v.int(body.days, 'Days', 1, 365), v.optStr(body.notes, 'Notes', 200), now().date
      ).lastInsertRowid
    );
    return reply(201, rxOut(db.prepare(RX_SQL + ' WHERE r.id = ?').get(id)));
  });

  /* ---- administration */
  route('GET', '/api/admin/stats', ['admin'], () => {
    const n = now();
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const usedBeds = one('SELECT COUNT(*) c FROM patients WHERE bed IS NOT NULL').c;
    const totalBeds = Object.values(WARDS).reduce((s, w) => s + w.total, 0);
    const used = new Map(db.prepare("SELECT substr(bed,1,1) k, COUNT(*) c FROM patients WHERE bed IS NOT NULL GROUP BY k").all().map((r) => [r.k, r.c]));
    return {
      patients: one('SELECT COUNT(*) c FROM patients').c,
      beds: { used: usedBeds, total: totalBeds },
      appointmentsToday: one("SELECT COUNT(*) c FROM appointments WHERE date = ? AND status != 'Cancelled'", n.date).c,
      pendingUsers: one("SELECT COUNT(*) c FROM users WHERE status = 'pending'").c,
      wards: Object.keys(WARDS).map((k) => ({ name: WARDS[k].name, total: WARDS[k].total, used: used.get(k) || 0 })),
      departments: DEPTS.map((d) => ({
        name: d,
        doctors: one("SELECT COUNT(*) c FROM doctors dr LEFT JOIN users u ON u.id = dr.user_id WHERE dr.dept = ? AND (u.id IS NULL OR u.status = 'active')", d).c,
        appointmentsToday: one("SELECT COUNT(*) c FROM appointments a JOIN doctors dr ON dr.id = a.doctor_id WHERE dr.dept = ? AND a.date = ? AND a.status != 'Cancelled'", d, n.date).c,
      })),
      doctors: db.prepare(`SELECT dr.id, dr.name, dr.dept,
          (SELECT COUNT(*) FROM appointments a WHERE a.doctor_id = dr.id AND a.date = ? AND a.status != 'Cancelled') AS today
        FROM doctors dr LEFT JOIN users u ON u.id = dr.user_id WHERE u.id IS NULL OR u.status = 'active' ORDER BY dr.name`).all(n.date),
    };
  });

  route('GET', '/api/admin/users', ['admin'], () =>
    db.prepare('SELECT id, name, email, role, status, dept, gender, created_at, (google_sub IS NOT NULL) AS google FROM users ORDER BY (status = \'pending\') DESC, id DESC')
      .all().map((u) => ({ ...u, google: !!u.google }))
  );

  route('POST', '/api/admin/users/:id/status', ['admin'], ({ user, params, body }) => {
    const id = Number(params.id);
    const status = v.oneOf(body.status, 'Status', ['active', 'disabled']);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.id === user.id) throw new HttpError(409, 'You cannot change your own account.');
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
    if (status !== 'active') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { id, status };
  });


  /* ---- doctor leaves */
  route('GET', '/api/leaves', ['doctor', 'admin'], ({ user }) => {
    if (user.role === 'doctor') {
      const d = doctorRowByUser(user.id);
      if (!d) return [];
      return db.prepare('SELECT * FROM doctor_leaves WHERE doctor_id = ? ORDER BY date').all(d.id);
    }
    return db.prepare(
      'SELECT l.*, d.name AS doctor_name FROM doctor_leaves l JOIN doctors d ON d.id = l.doctor_id ORDER BY l.date'
    ).all();
  });

  route('POST', '/api/leaves', ['doctor'], ({ user, body }) => {
    const d = doctorRowByUser(user.id);
    if (!d) throw bad('No doctor record linked to your account.');
    const date = v.date(body.date);
    const reason = v.optStr(body.reason, 'Reason', 200);
    const n = now();
    if (date < n.date) throw bad('Cannot mark leave for a past date.');
    try {
      const id = Number(
        db.prepare('INSERT INTO doctor_leaves(doctor_id,date,reason) VALUES (?,?,?)').run(d.id, date, reason).lastInsertRowid
      );
      return reply(201, db.prepare('SELECT * FROM doctor_leaves WHERE id = ?').get(id));
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'You already have a leave on that date.');
      throw e;
    }
  });

  route('DELETE', '/api/leaves/:id', ['doctor', 'admin'], ({ user, params }) => {
    const id = Number(params.id);
    const leave = db.prepare('SELECT * FROM doctor_leaves WHERE id = ?').get(id);
    if (!leave) throw new HttpError(404, 'Leave not found.');
    if (user.role === 'doctor') {
      const d = doctorRowByUser(user.id);
      if (!d || d.id !== leave.doctor_id) throw new HttpError(403, 'That is not your leave.');
    }
    db.prepare('DELETE FROM doctor_leaves WHERE id = ?').run(id);
    return { ok: true };
  });

  /* ---- patient appointment notification reminders (3 stages: 1 day before, day of, 1 hour before) */
  route('GET', '/api/notifications', ['patient'], ({ user }) => {
    const p = patientRowByUser(user.id);
    if (!p) return { notifications: [], unreadCount: 0 };
    const n = now();

    // Find all booked appointments for this patient
    const appts = db.prepare(
      `SELECT a.id, a.date, a.time, a.status, d.name AS doctor_name, d.dept, d.type AS doctor_type
     FROM appointments a
     JOIN doctors d ON d.id = a.doctor_id
     WHERE a.patient_id = ? AND a.status = 'Booked' AND a.date >= ?`
    ).all(p.id, n.date);

    for (const a of appts) {
      const apptDateTime = new Date(`${a.date}T${a.time}:00Z`).getTime();
      const currentDateTime = new Date(`${n.date}T${n.time}:00Z`).getTime();
      const minsUntil = Math.round((apptDateTime - currentDateTime) / (60 * 1000));

      // Reminder 1: A day before the appointment
      if (a.date === addDays(n.date, 1) || (minsUntil <= 24 * 60 && minsUntil > 12 * 60)) {
        db.prepare(
          `INSERT OR IGNORE INTO notifications(patient_id, appointment_id, type, title, message)
         VALUES (?, ?, '1_day_before', ?, ?)`
        ).run(
          p.id, a.id,
          'Reminder: Appointment Tomorrow',
          `Your appointment with ${a.doctor_name} (${a.dept}) is scheduled for tomorrow at ${a.time}. Please be on time.`
        );
      }

      // Reminder 2: On the day of the appointment
      if (a.date === n.date && minsUntil > 0) {
        db.prepare(
          `INSERT OR IGNORE INTO notifications(patient_id, appointment_id, type, title, message)
         VALUES (?, ?, 'day_of', ?, ?)`
        ).run(
          p.id, a.id,
          'Reminder: Appointment Today',
          `Your appointment with ${a.doctor_name} (${a.dept}) is today at ${a.time}. Please check in at the desk on arrival.`
        );
      }

      // Reminder 3: Before an hour of the appointment
      if (a.date === n.date && minsUntil <= 60 && minsUntil >= 0) {
        const minText = minsUntil <= 1 ? 'less than a minute' : `${minsUntil} minutes`;
        db.prepare(
          `INSERT OR IGNORE INTO notifications(patient_id, appointment_id, type, title, message)
         VALUES (?, ?, '1_hour_before', ?, ?)`
        ).run(
          p.id, a.id,
          'Urgent Reminder: Appointment in 1 Hour',
          `Your appointment with ${a.doctor_name} starts in ${minText} at ${a.time}! Please proceed to the clinic.`
        );
      }
    }

    const rows = db.prepare(
      `SELECT n.*, a.date AS appt_date, a.time AS appt_time, a.status AS appt_status, d.name AS doctor_name, d.dept
     FROM notifications n
     JOIN appointments a ON a.id = n.appointment_id
     JOIN doctors d ON d.id = a.doctor_id
     WHERE n.patient_id = ?
     ORDER BY n.id DESC`
    ).all(p.id);

    const unreadCount = rows.filter((r) => !r.read).length;
    return { notifications: rows, unreadCount };
  });

  route('POST', '/api/notifications/:id/read', ['patient'], ({ user, params }) => {
    const p = patientRowByUser(user.id);
    if (!p) throw bad('Patient record not found.');
    db.prepare('UPDATE notifications SET `read` = 1 WHERE id = ? AND patient_id = ?').run(Number(params.id), p.id);
    return { ok: true };
  });

  route('POST', '/api/notifications/read-all', ['patient'], ({ user }) => {
    const p = patientRowByUser(user.id);
    if (!p) throw bad('Patient record not found.');
    db.prepare('UPDATE notifications SET `read` = 1 WHERE patient_id = ?').run(p.id);
    return { ok: true };
  });

  /* ---- doctor timing extension & notifications */
  route('GET', '/api/doctor/timing', ['doctor', 'admin'], ({ user, query }) => {
    let docId;
    if (user.role === 'doctor') {
      const d = doctorRowByUser(user.id);
      if (!d) return { isExtended: false, extensionMinutes: 0, originalEndTime: '17:00', extendedEndTime: '17:00', emergencyCount: 0 };
      docId = d.id;
    } else {
      docId = v.int(query.doctorId, 'Doctor', 1, 1e9);
    }
    const date = query.date ? v.date(query.date) : now().date;
    const ext = db.prepare('SELECT * FROM doctor_timing_extensions WHERE doctor_id = ? AND date = ?').get(docId, date);
    if (!ext) {
      return { isExtended: false, extensionMinutes: 0, originalEndTime: '17:00', extendedEndTime: '17:00', emergencyCount: 0 };
    }
    return {
      isExtended: true,
      extensionMinutes: ext.extension_minutes,
      originalEndTime: ext.original_end_time,
      extendedEndTime: ext.extended_end_time,
      emergencyCount: ext.emergency_count,
      reason: ext.reason,
    };
  });

  route('GET', '/api/doctor/notifications', ['doctor'], ({ user }) => {
    const d = doctorRowByUser(user.id);
    if (!d) return { notifications: [], unreadCount: 0 };
    const rows = db.prepare(
      `SELECT dn.*, a.date AS appt_date, a.time AS appt_time, a.emergency_notes, p.name AS patient_name
     FROM doctor_notifications dn
     LEFT JOIN appointments a ON a.id = dn.appointment_id
     LEFT JOIN patients p ON p.id = a.patient_id
     WHERE dn.doctor_id = ?
     ORDER BY dn.id DESC`
    ).all(d.id);
    const unreadCount = rows.filter((r) => !r.read).length;
    return { notifications: rows, unreadCount };
  });

  route('POST', '/api/doctor/notifications/:id/read', ['doctor'], ({ user, params }) => {
    const d = doctorRowByUser(user.id);
    if (!d) throw bad('Doctor not found.');
    db.prepare('UPDATE doctor_notifications SET `read` = 1 WHERE id = ? AND doctor_id = ?').run(Number(params.id), d.id);
    return { ok: true };
  });

  route('POST', '/api/doctor/notifications/read-all', ['doctor'], ({ user }) => {
    const d = doctorRowByUser(user.id);
    if (!d) throw bad('Doctor not found.');
    db.prepare('UPDATE doctor_notifications SET `read` = 1 WHERE doctor_id = ?').run(d.id);
    return { ok: true };
  });

  /* ------------------------------------------------------------ http */
  const SECURITY = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; " +
      "base-uri 'none'; form-action 'self'",
  };

  function send(res, status, payload, extra = {}) {
    const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    const headers = { ...SECURITY, 'Content-Length': Buffer.byteLength(body), ...extra };
    if (res.cookie) headers['Set-Cookie'] = res.cookie;
    res.writeHead(status, headers);
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let total = 0;
      const chunks = [];
      req.on('data', (c) => {
        total += c.length;
        if (total > 100 * 1024) {
          req.destroy();
          reject(new HttpError(413, 'Request body is too large.'));
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new HttpError(400, 'Invalid JSON body.'));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(res, reqPath) {
    let rel = decodeURIComponent(reqPath.replace(/\0/g, ''));
    if (rel === '/' || rel === '') rel = '/index.html';
    const clean = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
    let target = path.join(cfg.publicDir, clean);
    if (!target.startsWith(cfg.publicDir)) target = path.join(cfg.publicDir, 'index.html');
    fs.stat(target, (err, st) => {
      if (err || !st.isFile()) {
        const idx = path.join(cfg.publicDir, 'index.html');
        return fs.readFile(idx, (e2, data) => (e2 ? send(res, 404, { error: 'Not found' }) : send(res, 200, data, { 'Content-Type': MIME['.html'] })));
      }
      const ext = path.extname(target);
      const mime = MIME[ext] || 'application/octet-stream';
      fs.readFile(target, (e2, data) => (e2 ? send(res, 500, { error: 'Could not read file' }) : send(res, 200, data, { 'Content-Type': mime })));
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      await ready;
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (!parsed.pathname.startsWith('/api/')) return serveStatic(res, parsed.pathname);

      // Automatically evaluate and cancel any missed appointments system-wide
      autoCancelMissedAppointments();

      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (!req.headers['x-requested-with']) throw new HttpError(403, 'Cross-site request blocked: missing request header.');
      }

      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.mh_session || null;
      const user = auth.lookupSession(db, token);

      let match = null, params = {}, routeObj = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(parsed.pathname);
        if (m) {
          match = m;
          routeObj = r;
          r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
          break;
        }
      }
      if (!routeObj) throw new HttpError(404, 'API endpoint not found.');

      if (routeObj.roles) {
        if (!user) throw new HttpError(401, 'Please sign in.');
        if (!routeObj.roles.includes(user.role)) throw new HttpError(403, 'Your role does not have access to this.');
      }

      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const query = Object.fromEntries(parsed.searchParams.entries());
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';

      const result = await routeObj.handler({ user, token, params, body, query, ip, req, res });
      const isReply = result && typeof result === 'object' && 'status' in result && 'body' in result && Object.keys(result).length === 2;
      const status = isReply ? result.status : 200;
      const payload = isReply ? result.body : result;
      send(res, status, payload, { 'Content-Type': 'application/json' });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const error = status === 500 ? (cfg.production ? 'Server error.' : e.message) : e.message;
      if (status === 500) console.error(e);
      send(res, status, { error }, { 'Content-Type': 'application/json' });
    }
  });

  return { server, db, cfg, ready, autoCancelMissedAppointments };
}

module.exports = { createApp };
