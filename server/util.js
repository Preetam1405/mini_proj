'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (m) => new HttpError(400, m);

const DEPTS = ['Cardiology', 'Orthopaedics', 'Pediatrics', 'Neurology', 'General Medicine', 'Gynaecology'];
const WARDS = {
  G: { name: 'General', total: 8 },
  C: { name: 'Cardiac', total: 6 },
  P: { name: 'Pediatric', total: 6 },
  N: { name: 'Neuro', total: 4 },
  O: { name: 'Ortho', total: 6 },
};
const SLOTS = [];
for (let h = 9; h <= 16; h++) {
  SLOTS.push(String(h).padStart(2, '0') + ':00', String(h).padStart(2, '0') + ':30');
}

function allBeds() {
  const out = [];
  for (const k of Object.keys(WARDS)) {
    for (let i = 1; i <= WARDS[k].total; i++) out.push(`${k}-${String(i).padStart(2, '0')}`);
  }
  return out;
}

/** Validators: each returns a clean value or throws a 400. */
const v = {
  str(x, name, { min = 1, max = 200 } = {}) {
    if (typeof x !== 'string') throw bad(`${name} is required.`);
    const s = x.trim();
    if (s.length < min) throw bad(`${name} is required.`);
    if (s.length > max) throw bad(`${name} is too long.`);
    return s;
  },
  optStr(x, name, max = 200) {
    if (x == null || x === '') return '';
    return v.str(x, name, { min: 0, max });
  },
  int(x, name, min, max) {
    const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}.`);
    return n;
  },
  num(x, name, min, max) {
    const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be a number from ${min} to ${max}.`);
    return n;
  },
  oneOf(x, name, list) {
    if (!list.includes(x)) throw bad(`${name} must be one of: ${list.join(', ')}.`);
    return x;
  },
  email(x) {
    const s = v.str(x, 'Email', { max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('Enter a valid email address.');
    return s;
  },
  password(x) {
    if (typeof x !== 'string' || x.length < 8) throw bad('Password must be at least 8 characters.');
    if (x.length > 200) throw bad('Password is too long.');
    return x;
  },
  date(x, name = 'Date') {
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) throw bad(`${name} must look like 2026-12-31.`);
    const d = new Date(x + 'T00:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== x) throw bad(`${name} is not a real date.`);
    return x;
  },
};

const patientCode = (id) => 'MH-' + (24000 + id);
function parsePatientCode(s) {
  const m = /^MH-(\d{1,9})$/.exec(String(s || ''));
  if (!m) return null;
  const n = Number(m[1]) - 24000;
  return n > 0 ? n : null;
}

function nowIn(tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[d.getUTCDay()];
}

function oneHourBefore(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return '00:00';
  const [h, m] = timeStr.split(':').map(Number);
  const prevH = (h - 1 + 24) % 24;
  return `${String(prevH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addMinutesToTime(timeStr, mins) {
  if (!timeStr || !timeStr.includes(':')) return '00:00';
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + mins;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

module.exports = { HttpError, bad, v, DEPTS, WARDS, SLOTS, allBeds, patientCode, parsePatientCode, nowIn, addDays, dayOfWeek, oneHourBefore, addMinutesToTime };
