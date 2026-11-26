'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');

let app, base;
const TODAY = '2030-06-10';
const NOW = { date: TODAY, time: '08:00' };

/** Tiny client that keeps its own cookie, like a browser tab. */
function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meridian', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json, headers: res.headers };
  };
}

before(async () => {
  app = createApp({
    dbPath: ':memory:', demo: true, now: () => NOW, googleClientId: 'test-client',
    verifyGoogle: async (cred, clientId) => {
      if (cred === 'bad') throw new Error('Google rejected the sign-in.');
      const [email, sub] = cred.split('|');
      return { email, sub, name: 'Gina Google' };
    },
  });
  await app.ready;
  await new Promise((r) => app.server.listen(0, r));
  base = 'http://127.0.0.1:' + app.server.address().port;
});
after(() => app.server.close());

const CREDS = {
  patient: { email: 'patient@meridian.demo', password: 'Demo@12345' },
  doctor: { email: 'doctor@meridian.demo', password: 'Demo@12345' },
  admin: { email: 'admin@meridian.demo', password: 'Demo@12345' },
};

async function loginAs(role) {
  const c = client();
  const r = await c('POST', '/api/auth/login', { role, ...CREDS[role] });
  assert.equal(r.status, 200);
  return c;
}

test('config is public and reports today in the hospital time zone', async () => {
  const r = await client()('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.body.today, TODAY);
  assert.equal(r.body.googleClientId, 'test-client');
});

test('protected routes need a session and the X-Requested-With header', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/appointments')).status, 401);
  assert.equal((await anon('POST', '/api/auth/login', { email: 'a@b.co', password: 'x', role: 'patient' }, { 'X-Requested-With': '' })).status, 403);
});

test('patient registers, gets a patient record, and can sign in again', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/register', { role: 'patient', name: 'Test Patient', email: 'Pat@Example.com', password: 'longenough1' });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  const me = await c('GET', '/api/patients/me');
  assert.equal(me.status, 200);
  assert.match(me.body.id, /^MH-\d+$/);
  const dup = await client()('POST', '/api/auth/register', { role: 'patient', name: 'X', email: 'pat@example.com', password: 'longenough1' });
  assert.equal(dup.status, 409);
  const again = client();
  assert.equal((await again('POST', '/api/auth/login', { role: 'patient', email: 'pat@example.com', password: 'longenough1' })).status, 200);
  assert.equal((await again('POST', '/api/auth/login', { role: 'patient', email: 'pat@example.com', password: 'wrong-password' })).status, 401);
});

test('weak passwords and invalid emails are rejected', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/register', { role: 'patient', name: 'A', email: 'a@b.co', password: 'short' })).status, 400);
  assert.equal((await c('POST', '/api/auth/register', { role: 'patient', name: 'A', email: 'nope', password: 'longenough1' })).status, 400);
});

test('staff registration waits for admin approval, then works', async () => {
  const c = client();
  const reg = await c('POST', '/api/auth/register', { role: 'doctor', name: 'New Doctor', email: 'newdoc@example.com', password: 'longenough1', dept: 'Cardiology' });
  assert.equal(reg.status, 202);
  assert.equal((await c('GET', '/api/patients')).status, 401);
  const login = await c('POST', '/api/auth/login', { role: 'doctor', email: 'newdoc@example.com', password: 'longenough1' });
  assert.equal(login.status, 403);
  assert.match(login.body.error, /approval/);

  const admin = await loginAs('admin');
  const users = await admin('GET', '/api/admin/users');
  const pending = users.body.find((u) => u.email === 'newdoc@example.com');
  assert.equal(pending.status, 'pending');
  assert.equal((await admin('POST', `/api/admin/users/${pending.id}/status`, { status: 'active' })).status, 200);
  assert.equal((await c('POST', '/api/auth/login', { role: 'doctor', email: 'newdoc@example.com', password: 'longenough1' })).status, 200);

  await admin('POST', `/api/admin/users/${pending.id}/status`, { status: 'disabled' });
  assert.equal((await c('GET', '/api/patients')).status, 401, 'disabling ends live sessions');
});

test('login checks the chosen role against the account', async () => {
  const r = await client()('POST', '/api/auth/login', { role: 'doctor', email: 'patient@meridian.demo', password: 'Demo@12345' });
  assert.equal(r.status, 403);
});

test('roles are enforced on every kind of data', async () => {
  const patient = await loginAs('patient');
  const doctor = await loginAs('doctor');
  const admin = await loginAs('admin');

  assert.equal((await patient('GET', '/api/patients')).status, 403, 'patients cannot list patients');
  assert.equal((await patient('GET', '/api/admin/stats')).status, 403);
  assert.equal((await patient('POST', '/api/prescriptions', {})).status, 403);
  assert.equal((await doctor('GET', '/api/admin/users')).status, 403);
  assert.equal((await admin('GET', '/api/admin/stats')).status, 200);
  assert.equal((await doctor('GET', '/api/patients')).status, 200);
});

test('patients only see their own appointments and prescriptions', async () => {
  const patient = await loginAs('patient');
  const appts = (await patient('GET', '/api/appointments')).body;
  assert.ok(appts.length >= 1 && appts.every((a) => a.patientId === 'MH-24001'));
  const rx = (await patient('GET', '/api/prescriptions')).body;
  assert.ok(rx.every((r) => r.patientId === 'MH-24001'));
});

test('booking: free slots shrink, double booking is refused, past times are refused', async () => {
  const patient = await loginAs('patient');
  const docs = (await patient('GET', '/api/doctors')).body;
  const doc = docs.find((d) => d.dept === 'Neurology');
  const date = '2030-06-11'; // Tuesday — Dr. Rohan Mehta (Neurology, visiting) is available Tue/Thu/Sat
  const before = (await patient('GET', `/api/slots?doctor=${doc.id}&date=${date}`)).body.slots;
  assert.ok(before.includes('10:00'));
  const ok = await patient('POST', '/api/appointments', { doctorId: doc.id, date, time: '10:00' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.patientId, 'MH-24001');
  const after2 = (await patient('GET', `/api/slots?doctor=${doc.id}&date=${date}`)).body.slots;
  assert.ok(!after2.includes('10:00'));
  assert.equal((await patient('POST', '/api/appointments', { doctorId: doc.id, date, time: '10:00' })).status, 409);
  assert.equal((await patient('POST', '/api/appointments', { doctorId: doc.id, date: TODAY, time: '08:00' })).status, 400, 'time already passed');
  assert.equal((await patient('POST', '/api/appointments', { doctorId: doc.id, date: '2030-02-30', time: '10:00' })).status, 400, 'impossible date');
  assert.equal((await patient('POST', '/api/appointments', { doctorId: doc.id, date, time: '03:00' })).status, 400, 'not a clinic slot');

  const cancel = await patient('PATCH', `/api/appointments/${ok.body.id}`, { status: 'Cancelled' });
  assert.equal(cancel.body.status, 'Cancelled');
  assert.equal((await patient('POST', '/api/appointments', { doctorId: doc.id, date, time: '10:00' })).status, 201, 'cancelled slot is free again');
});

test('appointment status changes follow the role and ownership rules', async () => {
  const doctor = await loginAs('doctor');
  const patient = await loginAs('patient');
  const admin = await loginAs('admin');
  const mine = (await doctor('GET', '/api/appointments')).body.find((a) => a.status === 'Booked');
  assert.equal((await patient('PATCH', `/api/appointments/${mine.id}`, { status: 'Cancelled' })).status, 403, 'not their appointment');
  assert.equal((await doctor('PATCH', `/api/appointments/${mine.id}`, { status: 'Cancelled' })).status, 403, 'doctors cannot cancel');
  assert.equal((await admin('PATCH', `/api/appointments/${mine.id}`, { status: 'Checked in' })).status, 200);
  assert.equal((await admin('PATCH', `/api/appointments/${mine.id}`, { status: 'Checked in' })).status, 409, 'already checked in');
  assert.equal((await doctor('PATCH', `/api/appointments/${mine.id}`, { status: 'Completed' })).status, 200);

  const others = (await admin('GET', '/api/appointments')).body.find((a) => a.doctorName !== 'Dr. Meera Iyer' && a.status === 'Booked');
  assert.equal((await doctor('PATCH', `/api/appointments/${others.id}`, { status: 'Completed' })).status, 403, "another doctor's patient");
});

test('admin registers, admits and discharges; beds cannot be double booked', async () => {
  const admin = await loginAs('admin');
  const np = await admin('POST', '/api/patients', { name: 'Walk In', age: 40, sex: 'M', phone: '99999 00000' });
  assert.equal(np.status, 201);
  assert.equal(np.body.allergy, 'None known');
  const code = np.body.id;
  assert.equal((await admin('POST', `/api/patients/${code}/admit`, { bed: 'G-01', cond: 'Observation' })).status, 200);
  assert.equal((await admin('POST', `/api/patients/${code}/admit`, { bed: 'G-02', cond: 'x' })).status, 409, 'already admitted');
  const np2 = (await admin('POST', '/api/patients', { name: 'Second', age: 30, sex: 'F', phone: '1' })).body;
  assert.equal((await admin('POST', `/api/patients/${np2.id}/admit`, { bed: 'G-01', cond: 'x' })).status, 409, 'bed taken');
  assert.equal((await admin('POST', `/api/patients/${np2.id}/admit`, { bed: 'Z-99', cond: 'x' })).status, 400, 'no such bed');
  const wards = (await admin('GET', '/api/beds')).body;
  assert.equal(wards.find((w) => w.key === 'G').beds[0].patient, 'Walk In');
  assert.equal((await admin('POST', `/api/patients/${code}/discharge`)).status, 200);
  assert.equal((await admin('POST', `/api/patients/${code}/discharge`)).status, 409);
});

test('doctor records vitals only for admitted patients and validates ranges', async () => {
  const doctor = await loginAs('doctor');
  const ok = await doctor('POST', '/api/patients/MH-24001/vitals', { bp: '120/80', hr: 72, temp: 36.9, spo2: 98 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.latest.bp, '120/80');
  assert.equal((await doctor('POST', '/api/patients/MH-24001/vitals', { bp: 'high', hr: 72, temp: 36.9, spo2: 98 })).status, 400);
  assert.equal((await doctor('POST', '/api/patients/MH-24001/vitals', { bp: '120/80', hr: 999, temp: 36.9, spo2: 98 })).status, 400);
  assert.equal((await doctor('POST', '/api/patients/MH-24004/vitals', { bp: '120/80', hr: 72, temp: 36.9, spo2: 98 })).status, 409, 'outpatient');
});

test('doctor writes a prescription the patient can then see', async () => {
  const doctor = await loginAs('doctor');
  const r = await doctor('POST', '/api/prescriptions', { patientId: 'MH-24001', drug: 'Test Drug 5 mg', dose: 'Once daily', days: 7 });
  assert.equal(r.status, 201);
  const patient = await loginAs('patient');
  assert.ok((await patient('GET', '/api/prescriptions')).body.some((x) => x.drug === 'Test Drug 5 mg'));
  assert.equal((await doctor('POST', '/api/prescriptions', { patientId: 'MH-24001', drug: 'X', dose: 'Y', days: 0 })).status, 400);
  assert.equal((await doctor('POST', '/api/prescriptions', { patientId: 'MH-99999', drug: 'X', dose: 'Y', days: 1 })).status, 400);
});

test('admin statistics add up', async () => {
  const admin = await loginAs('admin');
  const s = (await admin('GET', '/api/admin/stats')).body;
  assert.equal(s.beds.total, 30);
  assert.equal(s.wards.reduce((a, w) => a + w.total, 0), 30);
  assert.equal(s.wards.reduce((a, w) => a + w.used, 0), s.beds.used);
  assert.equal(s.departments.length, 6);
});

test('admins cannot disable their own account', async () => {
  const admin = await loginAs('admin');
  const me = (await admin('GET', '/api/me')).body.user;
  assert.equal((await admin('POST', `/api/admin/users/${me.id}/status`, { status: 'disabled' })).status, 409);
});

test('Google sign-in: creates patient, doctor, and admin accounts with role enforcement', async () => {
  const c = client();
  // Patient Google sign-in
  const first = await c('POST', '/api/auth/google', { role: 'patient', credential: 'gina@example.com|sub-1' });
  assert.equal(first.status, 200);
  assert.equal(first.body.user.role, 'patient');
  assert.equal((await c('GET', '/api/patients/me')).status, 200);

  // Same patient signs in again
  assert.equal((await client()('POST', '/api/auth/google', { role: 'patient', credential: 'gina@example.com|sub-1' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/google', { role: 'patient', credential: 'gina@example.com|other-sub' })).status, 401, 'different Google account');
  assert.equal((await client()('POST', '/api/auth/google', { role: 'doctor', credential: 'gina@example.com|sub-1' })).status, 403, 'role mismatch');
  assert.equal((await client()('POST', '/api/auth/google', { role: 'patient', credential: 'bad' })).status, 401);

  // Admin Google sign-in works for Admin portal
  const adminG = await client()('POST', '/api/auth/google', { role: 'admin', credential: 'newadmin@example.com|s-admin' });
  assert.equal(adminG.status, 200);
  assert.equal(adminG.body.user.role, 'admin');

  // Doctor Google sign-in creates account pending approval
  const staff = await client()('POST', '/api/auth/google', { role: 'doctor', credential: 'gdoc@example.com|s-doc', dept: 'Cardiology' });
  assert.equal(staff.status, 202);

  // Direct login with password fails for Google-only account
  const gOnly = await client()('POST', '/api/auth/login', { role: 'patient', email: 'gina@example.com', password: 'anything-long' });
  assert.equal(gOnly.status, 401);
  assert.match(gOnly.body.error, /Google/);
});

test('repeated wrong passwords are rate limited', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 10; i++) last = await c('POST', '/api/auth/login', { role: 'patient', email: 'ratelimit@example.com', password: 'wrong-password' });
  assert.equal(last.status, 429);
});

test('logout ends the session', async () => {
  const c = await loginAs('patient');
  assert.equal((await c('GET', '/api/me')).status, 200);
  await c('POST', '/api/auth/logout');
  assert.equal((await c('GET', '/api/me')).status, 401);
});

test('static files are served, paths cannot escape, SPA falls back to index', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const trav = await fetch(base + '/..%2F..%2Fpackage.json');
  assert.notEqual(trav.headers.get('content-type'), 'application/json');
  assert.ok(!(await trav.text()).includes('"meridian-hospital"'));
  const weird = await fetch(base + '/anything/else');
  assert.equal(weird.status, 200);
});

test('bad JSON and oversized bodies are handled', async () => {
  const bad = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meridian' }, body: '{nope' });
  assert.equal(bad.status, 400);
  const big = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meridian' }, body: JSON.stringify({ x: 'a'.repeat(200000) }) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
});

test('doctor type registration, availability, and leave management', async () => {
  const admin = await loginAs('admin');
  const patient = await loginAs('patient');

  // Register a visiting doctor
  const regVis = await client()('POST', '/api/auth/register', {
    role: 'doctor', name: 'Dr. Visiting Specialist', email: 'visiting@example.com', password: 'longenough1',
    dept: 'Neurology', type: 'visiting', availability: ['Tuesday', 'Thursday']
  });
  assert.equal(regVis.status, 202);

  // Admin approves account
  const users = await admin('GET', '/api/admin/users');
  const visUser = users.body.find((u) => u.email === 'visiting@example.com');
  await admin('POST', `/api/admin/users/${visUser.id}/status`, { status: 'active' });

  // Doctor logs in and verifies type
  const docClient = client();
  const docLogin = await docClient('POST', '/api/auth/login', { role: 'doctor', email: 'visiting@example.com', password: 'longenough1' });
  assert.equal(docLogin.status, 200);
  assert.equal(docLogin.body.user.doctorType, 'visiting');

  // Verify doctor shows in doctor list with type & availability
  const docs = (await patient('GET', '/api/doctors')).body;
  const doc = docs.find((d) => d.name === 'Dr. Visiting Specialist');
  assert.ok(doc);
  assert.equal(doc.type, 'visiting');
  assert.equal(doc.availability, 'Tuesday,Thursday');

  // Tuesday 2030-06-18 is available for this visiting doctor
  const testDate = '2030-06-18';
  const slotsBefore = (await patient('GET', `/api/slots?doctor=${doc.id}&date=${testDate}`)).body;
  assert.ok(slotsBefore.slots.includes('10:00'));
  assert.equal(slotsBefore.onLeave, undefined);

  // Doctor marks leave for 2030-06-18
  const leaveRes = await docClient('POST', '/api/leaves', { date: testDate, reason: 'Medical Conference' });
  assert.equal(leaveRes.status, 201);
  assert.equal(leaveRes.body.date, testDate);

  // Duplicate leave is rejected
  const dupLeave = await docClient('POST', '/api/leaves', { date: testDate, reason: 'Another reason' });
  assert.equal(dupLeave.status, 409);

  // Doctor can view leaves
  const leavesList = await docClient('GET', '/api/leaves');
  assert.equal(leavesList.status, 200);
  assert.ok(leavesList.body.some((l) => l.date === testDate && l.reason === 'Medical Conference'));

  // Patient views slots: shows doctor on leave
  const slotsOnLeave = (await patient('GET', `/api/slots?doctor=${doc.id}&date=${testDate}`)).body;
  assert.equal(slotsOnLeave.onLeave, true);
  assert.equal(slotsOnLeave.slots.length, 0);
  assert.match(slotsOnLeave.message, /on leave/i);

  // Patient attempts to book on doctor's leave date: rejected
  const bookAttempt = await patient('POST', '/api/appointments', { doctorId: doc.id, date: testDate, time: '10:00' });
  assert.equal(bookAttempt.status, 400);
  assert.match(bookAttempt.body.error, /on leave/i);

  // Doctor deletes the leave
  const delRes = await docClient('DELETE', `/api/leaves/${leaveRes.body.id}`);
  assert.equal(delRes.status, 200);

  // Slots are free again
  const slotsAfterDel = (await patient('GET', `/api/slots?doctor=${doc.id}&date=${testDate}`)).body;
  assert.equal(slotsAfterDel.onLeave, undefined);
  assert.ok(slotsAfterDel.slots.includes('10:00'));

  // Patient can now book successfully
  const bookSuccess = await patient('POST', '/api/appointments', { doctorId: doc.id, date: testDate, time: '10:00' });
  assert.equal(bookSuccess.status, 201);
  assert.equal(bookSuccess.body.doctorType, 'visiting');
});

test('patient appointment notification reminders for 3 intervals (1 day before, day of, 1 hour before)', async () => {
  const patient = await loginAs('patient');

  // Check appointments reminders structure
  const appts = (await patient('GET', '/api/appointments')).body;
  assert.ok(appts.length >= 1);
  const appt = appts[0];
  assert.ok(Array.isArray(appt.reminders));
  assert.equal(appt.reminders.length, 3);
  assert.deepEqual(appt.reminders.map((r) => r.type), ['1_day_before', 'day_of', '1_hour_before']);

  // Fetch notifications
  const notifs = await patient('GET', '/api/notifications');
  assert.equal(notifs.status, 200);
  assert.ok(Array.isArray(notifs.body.notifications));

  // Verify notifications include reminder stages
  const types = notifs.body.notifications.map((n) => n.type);
  assert.ok(types.includes('1_day_before') || types.includes('day_of'));

  // Verify marking a single notification as read
  if (notifs.body.notifications.length > 0) {
    const singleRead = await patient('POST', `/api/notifications/${notifs.body.notifications[0].id}/read`);
    assert.equal(singleRead.status, 200);
  }

  // Mark all notifications as read
  const readAll = await patient('POST', '/api/notifications/read-all');
  assert.equal(readAll.status, 200);
  const afterRead = await patient('GET', '/api/notifications');
  assert.equal(afterRead.body.unreadCount, 0);
});

test('missed appointments are automatically cancelled, patient notified, and can be rescheduled', async () => {
  const patient = await loginAs('patient');
  const doctor = await loginAs('doctor');
  const admin = await loginAs('admin');

  // Find patient's patient_id and the logged-in doctor's doctor_id
  const pUser = app.db.prepare("SELECT id FROM users WHERE email = 'patient@meridian.demo'").get();
  const pRow = app.db.prepare("SELECT id FROM patients WHERE user_id = ?").get(pUser.id);
  const dUser = app.db.prepare("SELECT id FROM users WHERE email = 'doctor@meridian.demo'").get();
  const dRow = app.db.prepare("SELECT id FROM doctors WHERE user_id = ?").get(dUser.id);

  // Insert a past appointment scheduled for 07:00 today (current time is 08:00) with status 'Booked'
  const insertStmt = app.db.prepare(`
    INSERT INTO appointments (patient_id, doctor_id, date, time, status)
    VALUES (?, ?, ?, ?, 'Booked')
  `);
  const info = insertStmt.run(pRow.id, dRow.id, TODAY, '07:00');
  const missedApptId = Number(info.lastInsertRowid);

  // Trigger any request; autoCancelMissedAppointments runs automatically on the system
  const apptsRes = await patient('GET', '/api/appointments');
  assert.equal(apptsRes.status, 200);

  const missedAppt = apptsRes.body.find((a) => a.id === missedApptId);
  assert.ok(missedAppt, 'Appointment should be in appointments list');
  assert.equal(missedAppt.status, 'Cancelled');
  assert.equal(missedAppt.cancelReason, 'Missed / No-show');

  // Verify doctor also sees it as Cancelled with Missed / No-show
  const docAppts = (await doctor('GET', '/api/appointments')).body;
  const docAppt = docAppts.find((a) => a.id === missedApptId);
  assert.ok(docAppt);
  assert.equal(docAppt.status, 'Cancelled');
  assert.equal(docAppt.cancelReason, 'Missed / No-show');

  // Verify admin also sees it
  const adminAppts = (await admin('GET', '/api/appointments')).body;
  const adminAppt = adminAppts.find((a) => a.id === missedApptId);
  assert.ok(adminAppt);
  assert.equal(adminAppt.status, 'Cancelled');
  assert.equal(adminAppt.cancelReason, 'Missed / No-show');

  // Verify patient received a missed visit notification
  const notifs = await patient('GET', '/api/notifications');
  assert.equal(notifs.status, 200);
  const missedNotif = notifs.body.notifications.find((n) => n.appointment_id === missedApptId && n.type === 'missed');
  assert.ok(missedNotif, 'Should have received a missed appointment notification');
  assert.match(missedNotif.message, /reschedule/i);

  // Patient reschedules the missed appointment to a future date
  const futureDate = '2030-06-14';
  const rescheduleRes = await patient('POST', `/api/appointments/${missedApptId}/reschedule`, {
    date: futureDate,
    time: '11:00',
  });
  assert.equal(rescheduleRes.status, 200);
  assert.equal(rescheduleRes.body.status, 'Booked');
  assert.equal(rescheduleRes.body.date, futureDate);
  assert.equal(rescheduleRes.body.time, '11:00');
  assert.equal(rescheduleRes.body.cancelReason, '');

  // Verify status is updated to Booked across the entire system
  const updatedPatientAppts = (await patient('GET', '/api/appointments')).body;
  const rescheduledAppt = updatedPatientAppts.find((a) => a.id === missedApptId);
  assert.equal(rescheduledAppt.status, 'Booked');
  assert.equal(rescheduledAppt.cancelReason, '');
  assert.equal(rescheduledAppt.date, futureDate);
});

test('emergency booking delays next patient by 20m, notifies patient & doctor, and extends doctor timing', async () => {
  const patient1 = await loginAs('patient');
  const doctor = await loginAs('doctor');
  const admin = await loginAs('admin');

  // Register a second patient who will book an emergency on the way to hospital
  const patient2 = client();
  const reg = await patient2('POST', '/api/auth/register', {
    role: 'patient',
    name: 'Emergency Patient',
    email: 'emg@test.example',
    password: 'StrongPassword9!',
  });
  assert.equal(reg.status, 201);

  const docs = (await patient1('GET', '/api/doctors')).body;
  const docMe = (await doctor('GET', '/api/me')).body.user;
  const myDoc = docs.find((d) => d.name.includes(docMe.name.replace(/^Dr\.\s*/i, ''))) || docs[0];
  const docId = myDoc.id;

  // 1. Patient 1 books a regular appointment at 15:00 today
  const regularBook = await patient1('POST', '/api/appointments', {
    doctorId: docId,
    date: TODAY,
    time: '15:00',
  });
  assert.equal(regularBook.status, 201);
  const regularApptId = regularBook.body.id;

  // 2. Patient 2 books an emergency slot on the way at 15:00
  const emBook = await patient2('POST', '/api/appointments/emergency', {
    doctorId: docId,
    time: '15:00',
    notes: 'Severe chest pain - on the way to hospital',
  });
  assert.equal(emBook.status, 201);
  assert.equal(emBook.body.appointment.isEmergency, true);
  assert.equal(emBook.body.appointment.time, '15:00');
  assert.equal(emBook.body.delayedAppointments.length, 1);
  assert.equal(emBook.body.delayedAppointments[0].originalTime, '15:00');
  assert.equal(emBook.body.delayedAppointments[0].newTime, '15:20');
  assert.equal(emBook.body.doctorExtension.extensionMinutes, 25);
  assert.equal(emBook.body.doctorExtension.extendedEndTime, '17:25');

  // 3. Verify Patient 1's appointment was delayed by 20 minutes to 15:20
  const p1Appts = (await patient1('GET', '/api/appointments')).body;
  const p1Appt = p1Appts.find((a) => a.id === regularApptId);
  assert.equal(p1Appt.time, '15:20');
  assert.equal(p1Appt.delayMinutes, 20);

  // 4. Verify Patient 1 receives an emergency_delay notification
  const p1Notifs = (await patient1('GET', '/api/notifications')).body.notifications;
  const delayNotif = p1Notifs.find((n) => n.appointment_id === regularApptId && n.type === 'emergency_delay');
  assert.ok(delayNotif, 'Patient 1 should receive emergency_delay notification');
  assert.match(delayNotif.message, /20 minutes/i);
  assert.match(delayNotif.message, /15:20/);

  // 5. Verify Doctor sees extended timing and emergency notification
  const docTiming = (await doctor('GET', '/api/doctor/timing')).body;
  assert.equal(docTiming.isExtended, true);
  assert.equal(docTiming.extensionMinutes, 25);
  assert.equal(docTiming.extendedEndTime, '17:25');

  const docNotifs = (await doctor('GET', '/api/doctor/notifications')).body;
  assert.ok(docNotifs.notifications.length >= 1);
  assert.equal(docNotifs.notifications[0].type, 'emergency_alert');
  assert.match(docNotifs.notifications[0].message, /extended by 25 minutes/i);

  // 6. Admin books an emergency slot for a direct walk-in patient without digital facility
  const walkinEm = await admin('POST', '/api/appointments/emergency', {
    doctorId: docId,
    name: 'Walk-in Emergency Patient',
    phone: '9876543210',
    age: 52,
    sex: 'M',
    time: '15:20',
    notes: 'Direct walk-in acute trauma',
  });
  assert.equal(walkinEm.status, 201);
  assert.equal(walkinEm.body.appointment.isEmergency, true);
  assert.equal(walkinEm.body.appointment.patientName, 'Walk-in Emergency Patient');
  assert.equal(walkinEm.body.doctorExtension.extensionMinutes, 50);
  assert.equal(walkinEm.body.doctorExtension.extendedEndTime, '17:50');
});

test('registration stores gender across all portals and age/phone/gender for patients', async () => {
  // Patient registers with gender, age, and phone number
  const patClient = client();
  const patReg = await patClient('POST', '/api/auth/register', {
    role: 'patient',
    name: 'Priya Sharma',
    email: 'priya.reg@example.com',
    password: 'StrongPassword9!',
    gender: 'F',
    age: 29,
    phone: '9876501234',
  });
  assert.equal(patReg.status, 201);
  assert.equal(patReg.body.user.gender, 'F');

  const patRecord = await patClient('GET', '/api/patients/me');
  assert.equal(patRecord.status, 200);
  assert.equal(patRecord.body.sex, 'F');
  assert.equal(patRecord.body.age, 29);
  assert.equal(patRecord.body.phone, '9876501234');

  // Doctor registers with gender
  const docClient = client();
  const docReg = await docClient('POST', '/api/auth/register', {
    role: 'doctor',
    name: 'Dr. Vikram Rao',
    email: 'vikram.reg@example.com',
    password: 'StrongPassword9!',
    dept: 'Cardiology',
    gender: 'M',
  });
  assert.equal(docReg.status, 202);

  // Admin registers with gender
  const admClient = client();
  const admReg = await admClient('POST', '/api/auth/register', {
    role: 'admin',
    name: 'Alex Admin',
    email: 'alex.reg@example.com',
    password: 'StrongPassword9!',
    gender: 'Other',
  });
  assert.equal(admReg.status, 201);
  assert.equal(admReg.body.user.gender, 'Other');

  // Admin users list includes gender for all portals
  const usersRes = await admClient('GET', '/api/admin/users');
  assert.equal(usersRes.status, 200);
  assert.equal(usersRes.body.find((u) => u.email === 'priya.reg@example.com').gender, 'F');
  assert.equal(usersRes.body.find((u) => u.email === 'vikram.reg@example.com').gender, 'M');
  assert.equal(usersRes.body.find((u) => u.email === 'alex.reg@example.com').gender, 'Other');

  // Invalid gender or age is rejected
  const badGender = await client()('POST', '/api/auth/register', {
    role: 'patient',
    name: 'Bad Gender',
    email: 'badg@example.com',
    password: 'StrongPassword9!',
    gender: 'UnknownValue',
  });
  assert.equal(badGender.status, 400);

  const badAge = await client()('POST', '/api/auth/register', {
    role: 'patient',
    name: 'Bad Age',
    email: 'bada@example.com',
    password: 'StrongPassword9!',
    gender: 'M',
    age: 200,
    phone: '9876543210',
  });
  assert.equal(badAge.status, 400);
});



