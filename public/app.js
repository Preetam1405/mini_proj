(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var fdate = function (s) {
    return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  };
  var WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  var toast = function (t) {
    var el = $('#toast');
    el.textContent = t;
    el.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.classList.remove('on'); }, 3000);
  };

  /* ---------- API ---------- */
  async function api(method, path, body) {
    var res = await fetch('/api' + path, {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meridian' },
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      var err = new Error((data && data.error) || 'Something went wrong. Try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------- date helpers ---------- */
  function isoDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDaysLocal(dateStr, n) {
    var parts = dateStr.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    d.setDate(d.getDate() + n);
    return isoDate(d);
  }
  function nextDate(dateStr) { return addDaysLocal(dateStr, 1); }
  function dayName(dateStr) {
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var parts = dateStr.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return days[d.getDay()];
  }
  function daysUntil(dateStr) {
    var parts = dateStr.split('-');
    var target = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var todayParts = cfg.today.split('-');
    var today = new Date(Number(todayParts[0]), Number(todayParts[1]) - 1, Number(todayParts[2]));
    return Math.round((target - today) / 86400000);
  }

  /* ---------- roles ---------- */
  var ROLES = {
    patient: {
      label: 'Patient',
      ini: 'P',
      desc: 'Book visits and see prescriptions.',
      nav: [['home', 'Overview'], ['book', 'Book appointment'], ['rx', 'Prescriptions']]
    },
    doctor: {
      label: 'Doctor',
      ini: 'D',
      desc: "Today's schedule, patient records and prescriptions.",
      nav: [['today', 'Today'], ['patients', 'Patients'], ['prescribe', 'Write prescription'], ['leaves', 'My Leaves']]
    },
    admin: {
      label: 'Admin',
      ini: 'A',
      desc: 'Hospital overview, patient registration, appointments, admissions, staff and departments.',
      nav: [
        ['overview', 'Overview'],
        ['register', 'Register patient'],
        ['desk', 'Appointments'],
        ['beds', 'Admissions'],
        ['people', 'People'],
        ['depts', 'Departments']
      ]
    },
  };

  var cfg = { googleClientId: null, today: '', time: '', depts: [] };
  var S = null, authRole = null, authMode = 'signin', tab = null;
  var bk = { dept: '', doc: '', date: '', time: '', weekOffset: 0 };
  var rsched = { open: false, apptId: null, docId: '', date: '', time: '', weekOffset: 0 };
  var doctorsCache = null, renderSeq = 0, peopleSearchQuery = '';

  function show(v) {
    ['landing', 'auth', 'app'].forEach(function (n) { $('#v-' + n).hidden = n !== v; });
    window.scrollTo(0, 0);
  }

  /* ---------- landing ---------- */
  var PREV = {
    patient: {
      path: '/patient',
      stats: [['Next visit', '10:30'], ['Active prescriptions', '3'], ['Health record', 'MH-24001']],
      rows: [['Dr. Meera Iyer', 'Cardiology · follow-up', 'Booked', 'ok'], ['Dr. Farah Khan', 'Pediatrics · review', 'Booked', 'ok'], ['Blood panel', 'Lab · fasting', 'Pending', 'warn']]
    },
    doctor: {
      path: '/doctor',
      stats: [['Patients today', '12'], ['Waiting', '3'], ['Completed', '5']],
      rows: [['Vikram Patel', 'Chest pain · 11:30', 'Checked in', 'ok'], ['Rhea Kapoor', 'Fever review · 14:00', 'Booked', 'grey'], ['Lakshmi Devi', 'Ward round · C-05', 'Stable', 'ok']]
    },
    admin: {
      path: '/admin',
      stats: [['Occupancy', '63%'], ['Admissions', '19 of 30'], ['Appointments today', '28']],
      rows: [['Cardiac ward', '5 of 6 beds', 'Busy', 'warn'], ['Neuro ward', '3 of 4 beds', 'Busy', 'warn'], ['Walk-in registration', 'MH-number issued instantly', 'Ready', 'ok']]
    },
  };

  function renderPreview(role) {
    var p = PREV[role];
    if (!p) return;
    $$('#pv-tabs .tab').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.role === role); });
    $('#pv-mock').innerHTML = '<div class="mock-bar"><span>meridian.app' + p.path + '</span><span>' + ROLES[role].label + ' view · sample</span></div><div class="mock-body"><div class="mock-stats">' +
      p.stats.map(function (s) { return '<div class="stat"><small>' + s[0] + '</small><b>' + s[1] + '</b></div>'; }).join('') + '</div><div class="rows">' +
      p.rows.map(function (r) { return '<div class="row"><div><strong>' + r[0] + '</strong><small>' + r[1] + '</small></div><span class="pill ' + r[3] + '">' + r[2] + '</span></div>'; }).join('') + '</div></div>';
  }

  function initLanding() {
    $('#pv-tabs').innerHTML = Object.keys(ROLES).map(function (k) { return '<button class="tab" role="tab" data-act="pv" data-role="' + k + '">' + ROLES[k].label + '</button>'; }).join('');
    $('#role-grid').innerHTML = Object.keys(ROLES).map(function (k) { var r = ROLES[k]; return '<button class="role" data-act="role" data-role="' + k + '"><span class="ini">' + r.ini + '</span><h3>' + r.label + '</h3><p>' + r.desc + '</p></button>'; }).join('');
    renderPreview('patient');
  }

  /* ---------- auth ---------- */
  var gisReady = null;
  function loadGoogle() {
    if (gisReady) return gisReady;
    gisReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = function () {
        window.google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onGoogle });
        resolve();
      };
      s.onerror = function () { gisReady = null; reject(new Error('Could not load Google sign-in.')); };
      document.head.appendChild(s);
    });
    return gisReady;
  }

  async function onGoogle(resp) {
    try {
      authMsg('');
      var dept = authRole === 'doctor' ? ($('#r-dept') ? $('#r-dept').value : 'General Medicine') : undefined;
      var docType2 = authRole === 'doctor' ? ($('#r-doctype') ? $('#r-doctype').value : 'regular') : undefined;
      var availability2 = undefined;
      if (authRole === 'doctor' && docType2 === 'visiting') {
        var checkedDays2 = $$('input[name="avail-day"]:checked').map(function (cb) { return cb.value; });
        availability2 = checkedDays2.length ? checkedDays2 : undefined;
      }
      var out = await api('POST', '/auth/google', { role: authRole, credential: resp.credential, dept: dept, type: docType2, availability: availability2 });
      if (out.pending) return pendingNotice(out.message);
      enter(out.user);
    } catch (e) { authMsg(e.message); }
  }

  async function drawGoogleButton() {
    var box = $('#g-box'), sep = $('#g-sep');
    box.innerHTML = '';
    box.hidden = sep.hidden = false;

    if (cfg.googleClientId) {
      try {
        await loadGoogle();
        box.innerHTML = '';
        window.google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: Math.min(320, box.clientWidth || 320) });
        return;
      } catch (e) { /* fallback to custom button below */ }
    }

    // Dev mode: custom Google button
    box.innerHTML = '<button type="button" class="google-btn" data-act="google">' +
      '<svg viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.616z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/></svg>' +
      '<span>Continue with Google</span></button>';
  }

  function openAuth(role) {
    authRole = role;
    $('#au-role').textContent = ROLES[role].label;
    $('#r-dept-l').hidden = role !== 'doctor';
    $('#r-dept').innerHTML = cfg.depts.map(function (d) { return '<option>' + d + '</option>'; }).join('');
    var patFields = $('#r-patient-l');
    if (patFields) patFields.hidden = role !== 'patient';
    var rAge = $('#r-age'), rPhone = $('#r-phone');
    if (rAge) rAge.required = role === 'patient';
    if (rPhone) rPhone.required = role === 'patient';
    var docTypeEl = $('#r-doctype-l');
    if (docTypeEl) docTypeEl.hidden = role !== 'doctor';
    var docAvailEl = $('#r-avail-l');
    if (docAvailEl) docAvailEl.hidden = true;
    var daysBox = $('#r-avail-days');
    if (daysBox) daysBox.innerHTML = WEEKDAYS.map(function (d) {
      return '<label class="day-check"><input type="checkbox" name="avail-day" value="' + d + '"> ' + d.slice(0, 3) + '</label>';
    }).join('');
    ['f-signin', 'f-register'].forEach(function (id) { $('#' + id).reset(); });
    setMode('signin');
    show('auth');
    $('#au-title').focus();
    drawGoogleButton();
  }

  function setMode(m) {
    authMode = m;
    $('#f-signin').hidden = m !== 'signin';
    $('#f-register').hidden = m !== 'register';
    $('#au-title').textContent = (m === 'signin' ? 'Sign in as ' : 'Register as ') + ROLES[authRole].label.toLowerCase();
    $('#t-signin').setAttribute('aria-selected', m === 'signin');
    $('#t-register').setAttribute('aria-selected', m === 'register');
    authMsg('');
  }

  function authMsg(t) { var el = $('#au-msg'); el.hidden = !t; el.textContent = t || ''; $('#au-ok').hidden = true; }
  function pendingNotice(text) {
    setMode('signin');
    var ok = $('#au-ok');
    ok.textContent = text;
    ok.hidden = false;
  }
  function enter(user) {
    S = user;
    tab = ROLES[user.role].nav[0][0];
    var initDate = cfg.today;
    if (cfg.time && cfg.time >= '16:00') initDate = nextDate(cfg.today);
    bk = { dept: '', doc: '', date: initDate, time: '', weekOffset: 0 };
    rsched = { open: false, apptId: null, docId: '', date: '', time: '', weekOffset: 0 };
    doctorsCache = null;
    show('app');
    renderApp();
  }

  /* ---------- shared view helpers ---------- */
  var pill = function (s, reason) {
    if (s === 'Cancelled' && reason === 'Missed / No-show') {
      return '<span class="pill crit" title="Patient did not visit at scheduled time">Missed &amp; Cancelled</span>';
    }
    var c = { 'Booked': '', 'Checked in': 'warn', 'Completed': 'ok', 'Cancelled': 'grey' }[s] || '';
    return '<span class="pill ' + c + '">' + s + '</span>';
  };
  function apptTable(list, actions) {
    if (!list.length) return '<p class="muted">Nothing here yet.</p>';
    return '<div class="scroll"><table><thead><tr><th>Date &amp; time</th><th>Patient</th><th>Doctor</th><th>Status</th><th></th></tr></thead><tbody>' +
      list.map(function (a) {
        var docBadge = a.doctorType ? ' <span class="type-badge ' + a.doctorType + '">' + (a.doctorType === 'visiting' ? 'Visiting' : 'Regular') + '</span>' : '';
        var emergencyPill = a.isEmergency ? ' <span class="pill crit" style="font-weight:700">🚨 EMERGENCY</span>' : '';
        var delayPill = a.delayMinutes > 0 ? ' <span class="pill warn" title="Delayed by ' + a.delayMinutes + ' mins due to emergency">⚠️ Delayed (+' + a.delayMinutes + 'm)</span>' : '';
        var rowClass = a.isEmergency ? ' class="emergency-row"' : '';
        var emgNote = a.emergencyNotes ? '<br><small class="muted" style="color:#DC2626">Note: ' + esc(a.emergencyNotes) + '</small>' : '';
        return '<tr' + rowClass + '><td><strong>' + a.time + '</strong>' + delayPill + '<br><span class="muted">' + fdate(a.date) + '</span></td><td>' +
          esc(a.patientName) + ' <span class="mono muted">' + a.patientId + '</span>' + emgNote + '</td><td>' +
          esc(a.doctorName) + docBadge + '<br><span class="muted">' + esc(a.dept) + '</span></td><td>' +
          pill(a.status, a.cancelReason) + emergencyPill + '</td><td>' + (actions ? actions(a) : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  var openAppt = function (a) { return a.status === 'Booked' || a.status === 'Checked in'; };
  var stat = function (label, val, mono) {
    return '<div class="stat"><small>' + label + '</small><b class="' + (mono ? 'big-mono mono' : '') + '">' + val + '</b></div>';
  };
  var sum = function (arr, fn) { return arr.reduce(function (s, x) { return s + fn(x); }, 0); };
  var patOpts = function (list, emptyLabel) {
    return '<option value="">' + (emptyLabel || 'Select patient') + '</option>' + list.map(function (p) {
      return '<option value="' + p.id + '">' + p.id + ' · ' + esc(p.name) + (p.bed ? ' (Bed ' + p.bed + ')' : '') + '</option>';
    }).join('');
  };
  function flag(v) {
    var s = [];
    if (v.hr < 60 || v.hr > 100) s.push('HR ' + v.hr);
    if (v.temp > 37.8) s.push(v.temp + ' °C');
    if (v.spo2 < 95) s.push('SpO₂ ' + v.spo2 + '%');
    return s.length ? '<span class="pill crit">' + s.join(', ') + '</span>' : '<span class="pill ok">Normal</span>';
  }
  function wardBoard(wards) {
    return '<div class="wards">' + wards.map(function (w) {
      return '<div class="ward"><h4>' + esc(w.name) + '</h4><div class="bed-grid">' +
        w.beds.map(function (b) {
          return '<div class="bed' + (b.patient ? ' occ' : '') + '"><span class="mono">' + b.id + '</span><small>' +
            esc(b.patient ? b.patient.split(' ')[0] : 'Free') + '</small></div>';
        }).join('') + '</div></div>';
    }).join('') + '</div>';
  }

  async function getDoctors() {
    if (!doctorsCache) doctorsCache = await api('GET', '/doctors');
    return doctorsCache;
  }

  /* -------- week calendar helpers -------- */
  function weekDates(offsetWeeks) {
    // Start from today + offsetWeeks*7
    var base = addDaysLocal(cfg.today, offsetWeeks * 7);
    return Array.from({ length: 7 }, function (_, i) { return addDaysLocal(base, i); });
  }

  /* Build week calendar for a regular doctor, with slot counts */
  function buildWeekCalendar(weekDates, slotMap, selectedDate, offset, context) {
    // context = 'bk' or 'rs'
    var prevAct = context === 'bk' ? 'bk-prev-week' : 'rs-prev-week';
    var nextAct = context === 'bk' ? 'bk-next-week' : 'rs-next-week';
    var dayAct = context === 'bk' ? 'pick-day' : 'rs-pick-day';

    var html = '<div class="cal-box">';
    html += '<div class="cal-nav">';
    html += '<button type="button" class="btn small" data-act="' + prevAct + '"' + (offset <= 0 ? ' disabled' : '') + '>&#8592; Prev week</button>';
    html += '<span class="muted" style="font-size:.85rem">' + fdate(weekDates[0]) + ' – ' + fdate(weekDates[6]) + '</span>';
    html += '<button type="button" class="btn small" data-act="' + nextAct + '">Next week &#8594;</button>';
    html += '</div>';
    html += '<div class="week-grid">';
    weekDates.forEach(function (d) {
      var count = slotMap[d] !== undefined ? slotMap[d] : '…';
      var isSelected = d === selectedDate;
      var isPast = d < cfg.today;
      html += '<button type="button" class="week-btn' + (isSelected ? ' selected' : '') + (isPast ? ' past' : '') + (count === 'leave' ? ' on-leave' : '') + '"' +
        ' data-act="' + dayAct + '" data-date="' + d + '"' + (isPast || count === 'leave' ? ' disabled' : '') + '>' +
        '<span class="week-day">' + dayName(d).slice(0, 3) + '</span>' +
        '<span class="week-date">' + fdate(d).split(',')[1].trim() + '</span>' +
        '<span class="week-slots">' + (isPast ? '—' : (count === 'leave' ? 'On Leave' : count === 0 ? 'Full' : count + (count === '…' ? '' : ' free'))) + '</span>' +
        '</button>';
    });
    html += '</div></div>';
    return html;
  }

  /* Build visiting-doctor calendar — show available dates in next 4 weeks */
  function buildVisitingCalendar(doc, slotMap, selectedDate, context) {
    var dayAct = context === 'bk' ? 'pick-visiting-date' : 'rs-pick-visiting-date';
    var availDays = doc.availability ? doc.availability.split(',').map(function (s) { return s.trim(); }) : [];
    var dates = [];
    for (var i = 0; i < 28; i++) {
      var d = addDaysLocal(cfg.today, i);
      if (d < cfg.today) continue;
      if (availDays.includes(dayName(d))) dates.push(d);
    }
    if (!dates.length) return '<p class="muted">No available dates in the next 4 weeks.</p>';

    var html = '<div class="visiting-box">';
    html += '<p class="muted" style="margin-bottom:8px;font-size:.85rem">Available on: <strong>' + availDays.join(', ') + '</strong></p>';
    html += '<div class="visiting-dates-grid">';
    dates.forEach(function (d) {
      var count = slotMap[d] !== undefined ? slotMap[d] : null;
      var isSelected = d === selectedDate;
      var isLeave = count === 'leave';
      html += '<button type="button" class="visiting-date-btn' + (isSelected ? ' selected' : '') + (isLeave ? ' on-leave' : '') + '" data-act="' + dayAct + '" data-date="' + d + '"' + (isLeave ? ' disabled' : '') + '>' +
        '<span class="vd-day">' + dayName(d).slice(0, 3) + '</span>' +
        '<span class="vd-date">' + fdate(d) + '</span>' +
        (count !== null ? '<span class="vd-slots">' + (isLeave ? 'On Leave' : count === 0 ? 'Full' : count + ' free') + '</span>' : '') +
        '</button>';
    });
    html += '</div></div>';
    return html;
  }

  /* ---------- reschedule modal ---------- */
  function renderRschedModal(html) {
    var existing = $('#rsched-overlay');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.id = 'rsched-overlay';
    div.className = 'modal-overlay';
    div.innerHTML = '<div class="modal-card">' + html + '</div>';
    document.body.appendChild(div);
  }
  function closeRschedModal() {
    rsched.open = false;
    var el = $('#rsched-overlay');
    if (el) el.remove();
  }

  /* ---------- emergency modal ---------- */
  function renderEmergencyModal(html) {
    var existing = $('#emergency-overlay');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.id = 'emergency-overlay';
    div.className = 'modal-overlay';
    div.innerHTML = '<div class="modal-card" style="max-width:540px">' + html + '</div>';
    document.body.appendChild(div);
  }
  function closeEmergencyModal() {
    var el = $('#emergency-overlay');
    if (el) el.remove();
  }

  async function openEmergencyModal(isAdmin) {
    var docs = await getDoctors();
    var patients = isAdmin ? (await api('GET', '/patients')) : [];
    var todayDocs = docs.filter(function (d) {
      var avail = d.availability ? d.availability.split(',').map(function (s) { return s.trim(); }) : [];
      return !avail.length || avail.includes(dayName(cfg.today));
    });
    if (!todayDocs.length) todayDocs = docs;

    var commonSymptoms = [
      'Severe chest pain',
      'Breathing difficulty',
      'High fever / Seizure',
      'Acute trauma / Road accident',
      'Acute abdominal pain',
      'Severe allergic reaction'
    ];

    var html = '';
    if (isAdmin) {
      html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">' +
        '<span class="pill crit" style="font-size:1rem;padding:4px 10px">🚨 EMERGENCY</span>' +
        '<h3 style="margin:0">Book Emergency Slot (Walk-In)</h3>' +
        '</div>' +
        '<p class="muted" style="margin-bottom:16px;font-size:.86rem">Book an immediate emergency slot for direct visiting walk-in patients who lack digital facilities. Next patient will be delayed by 20m and doctor timing extended by 25m.</p>' +
        '<form id="f-emergency">' +
        '<div style="margin-bottom:12px">' +
        '<label>Patient Type' +
        '<select id="em-pt-type">' +
        '<option value="existing">Existing Registered Patient</option>' +
        '<option value="walkin" selected>New Walk-in Patient (No Digital Facility)</option>' +
        '</select>' +
        '</label>' +
        '</div>' +
        '<div id="em-existing-sec" hidden style="margin-bottom:12px">' +
        '<label>Select Patient<select id="em-existing-pt">' + patOpts(patients) + '</select></label>' +
        '</div>' +
        '<div id="em-walkin-sec" style="margin-bottom:12px">' +
        '<div class="fgrid">' +
        '<label>Full Name<input id="em-name" required placeholder="Patient full name" maxlength="100"></label>' +
        '<label>Phone Number<input id="em-phone" required placeholder="Phone number" type="tel" maxlength="30"></label>' +
        '</div>' +
        '<div class="fgrid" style="margin-top:8px">' +
        '<label>Age<input id="em-age" type="number" min="0" max="120" placeholder="e.g. 45"></label>' +
        '<label>Sex<select id="em-sex"><option>F</option><option>M</option><option>Other</option></select></label>' +
        '</div>' +
        '</div>' +
        '<label>Assign On-Duty Doctor<select id="em-doc" required>' +
        todayDocs.map(function (d) { return '<option value="' + d.id + '">' + esc(d.name) + ' · ' + esc(d.dept) + ' (' + (d.type === 'visiting' ? 'Visiting' : 'Regular') + ')' + '</option>'; }).join('') +
        '</select></label>' +
        '<div style="margin-top:12px"><label>Emergency Condition / Triage Notes<input id="em-reason" required placeholder="Describe acute symptoms or emergency reason" maxlength="200" value="Acute emergency consultation"></label></div>' +
        '<div style="margin-top:6px;margin-bottom:14px"><small class="muted">Quick condition select:</small>' +
        '<div class="symptom-chips">' +
        commonSymptoms.map(function (s) { return '<button type="button" class="symptom-chip" data-act="chip" data-val="' + esc(s) + '">' + esc(s) + '</button>'; }).join('') +
        '</div>' +
        '</div>' +
        '<div style="background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.25);border-radius:10px;padding:10px 14px;font-size:.82rem;margin-bottom:16px;color:var(--ink)">' +
        '⚡ <strong>Auto-Impact:</strong> Immediate emergency slot assigned today. The next patient in queue is automatically pushed back by <strong>20 minutes</strong> with instant notification. The assigned doctor daily shift is extended by <strong>25 minutes</strong>.' +
        '</div>' +
        '<div style="display:flex;gap:10px">' +
        '<button type="submit" class="btn danger pulse" style="flex:1">🚨 Confirm Emergency Slot</button>' +
        '<button type="button" class="btn" data-act="close-emergency-modal">Cancel</button>' +
        '</div>' +
        '</form>';
    } else {
      html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">' +
        '<span class="pill crit" style="font-size:1rem;padding:4px 10px">🚨 EMERGENCY</span>' +
        '<h3 style="margin:0">Book Emergency Slot (On The Way)</h3>' +
        '</div>' +
        '<p class="muted" style="margin-bottom:16px;font-size:.86rem">Use this option if you are experiencing a medical emergency and currently traveling to Meridian Hospital. Emergency medical staff and your assigned doctor will be alerted before your arrival.</p>' +
        '<form id="f-emergency">' +
        '<label>Select Department &amp; Doctor<select id="em-doc" required>' +
        todayDocs.map(function (d) { return '<option value="' + d.id + '">' + esc(d.name) + ' · ' + esc(d.dept) + ' (' + (d.type === 'visiting' ? 'Visiting' : 'Regular') + ')' + '</option>'; }).join('') +
        '</select></label>' +
        '<div style="margin-top:12px"><label>What is your emergency condition?<input id="em-reason" required placeholder="e.g. Severe chest pain, breathing difficulty, accident..." maxlength="200" value="Severe acute symptoms - on the way to hospital"></label></div>' +
        '<div style="margin-top:6px;margin-bottom:14px"><small class="muted">Tap to select symptom:</small>' +
        '<div class="symptom-chips">' +
        commonSymptoms.map(function (s) { return '<button type="button" class="symptom-chip" data-act="chip" data-val="' + esc(s) + '">' + esc(s) + '</button>'; }).join('') +
        '</div>' +
        '</div>' +
        '<div style="background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.25);border-radius:10px;padding:10px 14px;font-size:.82rem;margin-bottom:16px;color:var(--ink)">' +
        '⚡ <strong>Emergency Priority:</strong> Your slot is booked for <strong>Today (Immediate Arrival)</strong>. Hospital triage will prioritize your arrival. The next scheduled patient is delayed by <strong>20 minutes</strong> and the doctor\'s daily timing extended to accommodate your emergency.' +
        '</div>' +
        '<div style="display:flex;gap:10px">' +
        '<button type="submit" class="btn danger pulse" style="flex:1">🚨 Confirm Emergency Slot</button>' +
        '<button type="button" class="btn" data-act="close-emergency-modal">Cancel</button>' +
        '</div>' +
        '</form>';
    }

    renderEmergencyModal(html);
  }

  async function openRschedModal(apptId) {
    rsched.open = true;
    rsched.apptId = apptId;
    rsched.weekOffset = 0;
    var docs = await getDoctors();
    if (!rsched.docId) rsched.docId = docs.length ? String(docs[0].id) : '';
    if (!rsched.date) rsched.date = (cfg.time && cfg.time >= '16:00') ? nextDate(cfg.today) : cfg.today;
    await redrawRschedModal(docs);
  }

  async function redrawRschedModal(docs) {
    if (!docs) docs = await getDoctors();
    var selectedDoc = docs.find(function (d) { return String(d.id) === String(rsched.docId); }) || docs[0];
    if (selectedDoc && String(selectedDoc.id) !== String(rsched.docId)) rsched.docId = String(selectedDoc.id);

    var calHtml = '';
    var slotsHtml = '';
    var slots = [];

    if (selectedDoc) {
      var isVisiting = selectedDoc.type === 'visiting';
      var slotMap = {};

      if (isVisiting) {
        // For visiting: pre-fetch slots for visible dates
        var availDays = selectedDoc.availability ? selectedDoc.availability.split(',').map(function (s) { return s.trim(); }) : [];
        var visibleDates = [];
        for (var i = 0; i < 28; i++) {
          var d = addDaysLocal(cfg.today, i);
          if (availDays.includes(dayName(d))) visibleDates.push(d);
        }
        await Promise.all(visibleDates.map(async function (d) {
          try {
            var r = await api('GET', '/slots?doctor=' + encodeURIComponent(selectedDoc.id) + '&date=' + encodeURIComponent(d));
            slotMap[d] = r.onLeave ? 'leave' : (r.slots ? r.slots.length : 0);
          } catch (e) { slotMap[d] = 0; }
        }));
        // ensure rsched.date is a valid visiting date
        if (!rsched.date || !availDays.includes(dayName(rsched.date))) {
          rsched.date = visibleDates.length ? visibleDates[0] : rsched.date;
        }
        calHtml = buildVisitingCalendar(selectedDoc, slotMap, rsched.date, 'rs');
      } else {
        // Regular doctor: week view
        var wdates = weekDates(rsched.weekOffset);
        await Promise.all(wdates.map(async function (d) {
          if (d < cfg.today) { slotMap[d] = 0; return; }
          try {
            var r = await api('GET', '/slots?doctor=' + encodeURIComponent(selectedDoc.id) + '&date=' + encodeURIComponent(d));
            slotMap[d] = r.onLeave ? 'leave' : (r.slots ? r.slots.length : 0);
          } catch (e) { slotMap[d] = 0; }
        }));
        calHtml = buildWeekCalendar(wdates, slotMap, rsched.date, rsched.weekOffset, 'rs');
      }

      // Fetch slots for selected date
      if (rsched.date) {
        try {
          var sd = await api('GET', '/slots?doctor=' + encodeURIComponent(selectedDoc.id) + '&date=' + encodeURIComponent(rsched.date));
          slots = sd.slots || [];
          if (sd.message) slotsHtml = '<p class="muted">' + esc(sd.message) + '</p>';
        } catch (e) { slots = []; }
      }
      if (!rsched.time || !slots.includes(rsched.time)) rsched.time = slots.length ? slots[0] : '';
    }

    if (!slotsHtml) {
      slotsHtml = slots.length
        ? '<div class="slot-grid">' + slots.map(function (t) {
          return '<button type="button" class="slot-btn' + (t === rsched.time ? ' selected' : '') + '" data-act="rs-pick-slot" data-slot="' + t + '">' + t + '</button>';
        }).join('') + '</div>'
        : '<p class="muted">No available slots for ' + (rsched.date ? fdate(rsched.date) : 'selected date') + '.</p>';
    }

    var html = '<h3>Reschedule Appointment</h3>' +
      '<form id="f-rsched">' +
      '<label>Doctor<select id="rs-doc">' +
      docs.map(function (d) { return '<option value="' + d.id + '"' + (String(d.id) === String(rsched.docId) ? ' selected' : '') + '>' + esc(d.name) + ' · ' + esc(d.dept) + ' (' + (d.type === 'visiting' ? 'Visiting' : 'Regular') + ')' + '</option>'; }).join('') +
      '</select></label>' +
      '<div style="margin-top:12px"><strong>Select a date</strong></div>' +
      calHtml +
      '<div style="margin-top:12px"><strong>Available slots</strong> <span class="mono muted">for ' + (rsched.date ? fdate(rsched.date) : '—') + '</span></div>' +
      slotsHtml +
      '<input type="hidden" id="rs-time" value="' + esc(rsched.time) + '">' +
      '<div style="margin-top:16px;display:flex;gap:8px">' +
      '<button class="btn primary" type="submit"' + (!rsched.time ? ' disabled' : '') + '>Confirm reschedule</button>' +
      '<button class="btn" type="button" data-act="close-modal">Cancel</button>' +
      '</div>' +
      '</form>';

    renderRschedModal(html);
  }

  /* ---------- views (each returns HTML) ---------- */
  var VIEWS = {
    patient: {
      home: async function () {
        var r = await Promise.all([
          api('GET', '/patients/me'),
          api('GET', '/appointments'),
          api('GET', '/prescriptions'),
          api('GET', '/notifications')
        ]);
        var me = r[0], allAppts = r[1], notifData = r[3] || { notifications: [], unreadCount: 0 };
        var upcoming = allAppts.filter(function (a) { return a.status === 'Booked' && a.date >= cfg.today; });
        upcoming.sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; });
        var next = upcoming[0] || null;

        // Missed appointments alert box (auto-cancelled with option to reschedule)
        var missedAppts = allAppts.filter(function (a) {
          return a.status === 'Cancelled' && a.cancelReason === 'Missed / No-show';
        });
        var missedBanner = '';
        if (missedAppts.length) {
          missedBanner = '<div class="missed-alert-box">' +
            '<div class="mab-head">' +
            '<div>⚠️ <strong>Missed Appointment' + (missedAppts.length > 1 ? 's (' + missedAppts.length + ')' : '') + '</strong></div>' +
            '<span class="pill crit">Action: Reschedule</span>' +
            '</div>' +
            '<p class="muted" style="margin:4px 0 10px;font-size:.85rem">You did not visit the doctor at the scheduled time. The appointment was automatically cancelled. Click Reschedule to book a new appointment.</p>' +
            '<div class="mab-list">' +
            missedAppts.map(function (a) {
              return '<div class="mab-item">' +
                '<div><strong>' + esc(a.doctorName) + '</strong> (' + esc(a.dept) + ')<br><small class="muted">Scheduled: ' + fdate(a.date) + ' at ' + a.time + '</small></div>' +
                '<button type="button" class="btn small primary" data-act="reschedule" data-id="' + a.id + '">Reschedule Now</button>' +
                '</div>';
            }).join('') +
            '</div></div>';
        }

        // Active notification reminders alert box
        var notifBanner = '';
        var notifList = notifData.notifications || [];
        if (notifList.length) {
          notifBanner = '<div class="reminders-alert-box">' +
            '<div class="rab-head">' +
            '<div>🔔 <strong>Appointment Reminders (' + notifList.length + ')</strong> <span class="muted" style="font-size:.8rem">— 3 reminders per visit (1 day before, day of, 1 hour before)</span></div>' +
            '<button type="button" class="btn small" data-act="mark-notifs-read">Dismiss all</button>' +
            '</div>' +
            '<div class="rab-items">' +
            notifList.slice(0, 3).map(function (n) {
              var badgeText = n.type === 'emergency_delay' ? '🚨 Emergency Delay (+20m)' : n.type === 'missed' ? '⚠️ Missed Visit' : n.type === '1_hour_before' ? '⏰ 1 Hour Before' : n.type === 'day_of' ? '🗓 Day of Visit' : '📅 1 Day Before';
              var badgeClass = (n.type === 'emergency_delay' || n.type === 'missed' || n.type === '1_hour_before') ? 'crit' : 'ok';
              return '<div class="rab-item">' +
                '<div class="rab-item-head"><span class="pill ' + badgeClass + '">' + badgeText + '</span><small class="muted">' + esc(n.appt_date) + ' at ' + esc(n.appt_time) + '</small></div>' +
                '<strong>' + esc(n.title) + '</strong>' +
                '<p>' + esc(n.message) + '</p>' +
                '</div>';
            }).join('') +
            '</div></div>';
        }

        // Upcoming visit card
        var visitCard = '';
        if (next) {
          var diff = daysUntil(next.date);
          var when = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : 'In ' + diff + ' days';
          var docBadge = next.doctorType ? ' <span class="type-badge ' + next.doctorType + '">' + (next.doctorType === 'visiting' ? 'Visiting' : 'Regular') + '</span>' : '';

          var reminderStageHtml = '';
          if (next.reminders && next.reminders.length) {
            reminderStageHtml = '<div class="reminder-box">' +
              '<div class="rb-title"><span>🔔 <strong>Reminders Set (3 Times)</strong></span><span class="muted" style="font-size:.78rem">Sent before your visit</span></div>' +
              '<div class="rb-grid">' +
              next.reminders.map(function (rem, idx) {
                var badgeClass = rem.status === 'active' ? 'warn' : rem.status === 'sent' ? 'ok' : 'grey';
                var statusText = rem.status === 'active' ? 'Active Now' : rem.status === 'sent' ? 'Delivered' : 'Scheduled';
                return '<div class="rb-card ' + rem.status + '">' +
                  '<div class="rb-top"><span class="mono" style="font-size:.72rem">Reminder ' + (idx + 1) + '</span><span class="pill ' + badgeClass + '">' + statusText + '</span></div>' +
                  '<strong>' + esc(rem.label) + '</strong>' +
                  '<small class="muted">' + esc(rem.when) + '</small>' +
                  '</div>';
              }).join('') +
              '</div></div>';
          }

          var emergencyNotice = '';
          if (next.isEmergency) {
            emergencyNotice = '<div style="background:rgba(220,38,38,0.1);border:1px solid #DC2626;border-radius:10px;padding:10px 14px;margin:10px 0;color:var(--ink)"><strong>🚨 Emergency Slot Confirmed:</strong> Your emergency booking is active for today. Emergency staff and doctor are alerted for your arrival.</div>';
          } else if (next.delayMinutes > 0) {
            emergencyNotice = '<div class="delay-notice-box">⚠️ <strong>Schedule Notice:</strong> Your appointment with ' + esc(next.doctorName) + ' has been delayed by ' + next.delayMinutes + ' minutes (now scheduled for <strong>' + next.time + '</strong>) due to an urgent incoming emergency case. Thank you for your patience.</div>';
          }

          visitCard = '<div class="next-visit-card">' +
            '<div class="visit-header"><span class="visit-label">🗓 Upcoming Visit</span><span class="pill ok">' + when + '</span></div>' +
            emergencyNotice +
            '<div class="visit-detail">' +
            '<div class="visit-row"><span class="visit-key">Doctor</span><span class="visit-val">' + esc(next.doctorName) + docBadge + '</span></div>' +
            '<div class="visit-row"><span class="visit-key">Department</span><span class="visit-val">' + esc(next.dept) + '</span></div>' +
            '<div class="visit-row"><span class="visit-key">Date</span><span class="visit-val">' + fdate(next.date) + ' (' + dayName(next.date) + ')</span></div>' +
            '<div class="visit-row"><span class="visit-key">Time</span><span class="visit-val"><strong>' + next.time + '</strong>' + (next.delayMinutes > 0 ? ' <span class="pill warn">+' + next.delayMinutes + 'm delayed</span>' : '') + '</span></div>' +
            '</div>' +
            reminderStageHtml +
            '<div style="margin-top:10px">' +
            '<button class="btn small danger" data-act="appt" data-status="Cancelled" data-id="' + next.id + '">Cancel</button> ' +
            '<button class="btn small primary" data-act="reschedule" data-id="' + next.id + '">Reschedule</button>' +
            '</div>' +
            '</div>';
        } else {
          visitCard = '<div class="next-visit-card empty">' +
            '<p>No upcoming appointments booked.</p>' +
            '<button class="btn primary small" data-act="tab" data-tab="book">Book an appointment</button>' +
            '</div>';
        }

        var emergencyCard = '<div class="emergency-patient-card">' +
          '<div class="epc-left">' +
          '<div class="epc-badge">🚨 EMERGENCY CARE</div>' +
          '<h3>On your way to the hospital?</h3>' +
          '<p>Book an emergency slot on your way to Meridian Hospital. ER staff and on-duty doctors will prepare for your arrival.</p>' +
          '</div>' +
          '<button type="button" class="btn danger pulse" data-act="open-emergency-modal">🚨 Book Emergency Slot</button>' +
          '</div>';

        return missedBanner + notifBanner + emergencyCard +
          '<h2>Hello, ' + esc(S.name.split(' ')[0]) + '</h2>' +
          '<div class="stats">' +
          stat('Your patient number', esc(me.id), true) +
          stat('Upcoming visits', upcoming.length) +
          stat('Prescriptions', r[2].length) +
          '</div>' +
          visitCard +
          '<div class="card"><h3>Your appointments</h3>' +
          apptTable(allAppts.filter(function (a) { return a.date >= cfg.today || a.status === 'Booked'; }), function (a) {
            var btns = '';
            if (a.status === 'Booked') btns += '<button class="btn small danger" data-act="appt" data-status="Cancelled" data-id="' + a.id + '">Cancel</button> ';
            if (a.status === 'Booked' || a.status === 'Cancelled') btns += '<button class="btn small" data-act="reschedule" data-id="' + a.id + '">Reschedule</button>';
            return btns;
          }) +
          '<div style="margin-top:12px"><button class="btn primary" data-act="tab" data-tab="book">Book an appointment</button></div>' +
          '</div>';
      },

      book: async function () {
        var docs = await getDoctors();
        var list = docs.filter(function (d) { return !bk.dept || d.dept === bk.dept; });
        if (!bk.doc && list.length) bk.doc = String(list[0].id);

        var selectedDoc = list.find(function (d) { return String(d.id) === String(bk.doc); }) || list[0];
        if (selectedDoc && String(selectedDoc.id) !== String(bk.doc)) bk.doc = String(selectedDoc.id);

        var isVisiting = selectedDoc && selectedDoc.type === 'visiting';
        var availDays = selectedDoc && selectedDoc.availability ? selectedDoc.availability.split(',').map(function (s) { return s.trim(); }) : [];

        // Validate / auto-fix date
        if (!bk.date || bk.date < cfg.today) {
          bk.date = (cfg.time && cfg.time >= '16:00') ? nextDate(cfg.today) : cfg.today;
        }
        if (isVisiting && !availDays.includes(dayName(bk.date))) {
          // Find next valid day
          for (var i = 0; i < 28; i++) {
            var candidate = addDaysLocal(cfg.today, i);
            if (availDays.includes(dayName(candidate))) { bk.date = candidate; break; }
          }
        }

        // Build slot map for calendar
        var slotMap = {};
        var slotsHtml = '';
        var slots = [];

        if (selectedDoc) {
          if (isVisiting) {
            var visibleVisitDates = [];
            for (var vi = 0; vi < 28; vi++) {
              var vd = addDaysLocal(cfg.today, vi);
              if (availDays.includes(dayName(vd))) visibleVisitDates.push(vd);
            }
            await Promise.all(visibleVisitDates.map(async function (d) {
              try {
                var r2 = await api('GET', '/slots?doctor=' + encodeURIComponent(selectedDoc.id) + '&date=' + encodeURIComponent(d));
                slotMap[d] = r2.onLeave ? 'leave' : (r2.slots ? r2.slots.length : 0);
              } catch (e) { slotMap[d] = 0; }
            }));
          } else {
            var wdates = weekDates(bk.weekOffset);
            await Promise.all(wdates.map(async function (d) {
              if (d < cfg.today) { slotMap[d] = 0; return; }
              try {
                var r3 = await api('GET', '/slots?doctor=' + encodeURIComponent(selectedDoc.id) + '&date=' + encodeURIComponent(d));
                slotMap[d] = r3.onLeave ? 'leave' : (r3.slots ? r3.slots.length : 0);
              } catch (e) { slotMap[d] = 0; }
            }));
          }

          // Fetch slots for selected date
          try {
            var sd2 = await api('GET', '/slots?doctor=' + encodeURIComponent(selectedDoc.id) + '&date=' + encodeURIComponent(bk.date));
            slots = sd2.slots || [];
            if (sd2.message) slotsHtml = '<div class="no-slots"><span>' + esc(sd2.message) + '</span></div>';
          } catch (e) { slots = []; }

          if (!bk.time || !slots.includes(bk.time)) bk.time = slots.length ? slots[0] : '';
        }

        if (!slotsHtml) {
          if (slots.length) {
            slotsHtml = '<div class="slot-grid">' + slots.map(function (t) {
              return '<button type="button" class="slot-btn' + (t === bk.time ? ' selected' : '') + '" data-act="pick-slot" data-slot="' + t + '">' + t + '</button>';
            }).join('') + '</div>';
          } else {
            slotsHtml = '<div class="no-slots"><span>No slots for ' + fdate(bk.date) + '.</span>' +
              (!isVisiting ? '<button type="button" class="btn small primary" data-act="quick-tomorrow">See Tomorrow\'s Slots</button>' : '') +
              '</div>';
          }
        }

        var calHtml = isVisiting
          ? buildVisitingCalendar(selectedDoc, slotMap, bk.date, 'bk')
          : buildWeekCalendar(weekDates(bk.weekOffset), slotMap, bk.date, bk.weekOffset, 'bk');

        var bookEmergencyCard = '<div class="emergency-patient-card" style="margin-bottom:16px;padding:14px 18px">' +
          '<div class="epc-left">' +
          '<div class="epc-badge">🚨 IMMEDIATE EMERGENCY CARE</div>' +
          '<p style="margin:2px 0 0">Traveling to hospital in an emergency? Book an emergency slot for priority care on arrival.</p>' +
          '</div>' +
          '<button type="button" class="btn small danger pulse" data-act="open-emergency-modal">🚨 Emergency Booking</button>' +
          '</div>';

        return '<h2>Book an appointment</h2>' + bookEmergencyCard + '<div class="card"><form id="f-book">' +
          '<div class="fgrid">' +
          '<label>Department<select id="bk-dept" data-bind="dept"><option value="">All departments</option>' + cfg.depts.map(function (d) { return '<option' + (d === bk.dept ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></label>' +
          '<label>Doctor<select id="bk-doc" data-bind="doc" required>' + list.map(function (d) { return '<option value="' + d.id + '"' + (String(d.id) === String(bk.doc) ? ' selected' : '') + '>' + esc(d.name) + ' · ' + d.dept + ' (' + (d.type === 'visiting' ? 'Visiting' : 'Regular') + ')' + '</option>'; }).join('') + '</select></label>' +
          '</div>' +
          (isVisiting
            ? '<div style="margin:8px 0"><span class="pill warn">Visiting Doctor</span> <span class="muted" style="font-size:.85rem">Select an available date below</span></div>'
            : '') +
          '<div style="margin-top:12px"><strong>Select a date</strong></div>' +
          calHtml +
          '<div class="slots-box" style="margin-top:16px">' +
          '<div class="slots-head">' +
          '<div><strong>Available Slots</strong> <span class="mono muted">(' + slots.length + ' free)</span></div>' +
          '<span class="pill' + (bk.date === cfg.today ? ' ok' : '') + '">' + (bk.date === cfg.today ? 'Today · ' : '') + fdate(bk.date) + '</span>' +
          '</div>' +
          '<label style="display:none">Selected slot<input id="bk-time" value="' + esc(bk.time) + '" readonly required></label>' +
          slotsHtml +
          '</div>' +
          '<div style="margin-top:16px"><button class="btn primary" type="submit"' + (!bk.time ? ' disabled' : '') + '>Confirm booking</button></div>' +
          '</form></div>';
      },

      rx: async function () {
        var l = await api('GET', '/prescriptions');
        return '<h2>Prescriptions</h2><div class="card">' + (l.length ? '<div class="scroll"><table><thead><tr><th>Medicine</th><th>How to take</th><th>Days</th><th>Prescribed</th></tr></thead><tbody>' + l.map(function (r) {
          return '<tr><td><strong>' + esc(r.drug) + '</strong><br><span class="muted">' + esc(r.notes) + '</span></td><td>' + esc(r.dose) + '</td><td class="num">' + r.days + '</td><td>' + esc(r.doctorName) + '<br><span class="muted">' + fdate(r.date) + '</span></td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted">No prescriptions yet.</p>') + '</div>';
      },
    },

    doctor: {
      today: async function () {
        var r = await Promise.all([
          api('GET', '/appointments'),
          api('GET', '/doctor/timing')
        ]);
        var allAppts = r[0];
        var timing = r[1] || { isExtended: false, extensionMinutes: 0 };
        var l = allAppts.filter(function (a) { return a.date === cfg.today && a.status !== 'Cancelled'; });
        var n = function (s) { return l.filter(function (a) { return a.status === s; }).length; };
        var emergencies = l.filter(function (a) { return a.isEmergency; });
        var typeBadge = (S && S.doctorType) ? ' <span class="type-badge ' + S.doctorType + '">' + (S.doctorType === 'visiting' ? 'Visiting Doctor' : 'Regular Doctor') + '</span>' : '';

        var alertBox = '';
        if (timing.isExtended || emergencies.length) {
          alertBox = '<div class="emergency-doctor-alert">' +
            '<div class="eda-header">' +
            '<div style="display:flex;align-items:center;gap:8px">' +
            '<span class="pill crit" style="font-size:.85rem;padding:4px 10px">🚨 EMERGENCY NOTICE</span>' +
            '<strong>Daily Timing Extended by ' + timing.extensionMinutes + ' Minutes</strong>' +
            '</div>' +
            '<span class="pill warn">Timing: ' + timing.originalEndTime + ' ➔ ' + timing.extendedEndTime + '</span>' +
            '</div>' +
            '<p style="margin:6px 0;font-size:.88rem">An emergency case was booked with you today. Your clinic hours have been extended to <strong>' + timing.extendedEndTime + '</strong> (+' + timing.extensionMinutes + ' mins) to accommodate this emergency case without cancelling patients. The next patient in queue was notified of a 20-minute delay.</p>' +
            (emergencies.length ? '<div class="eda-list">' + emergencies.map(function (em) {
              return '<div class="eda-item"><strong>🚨 Emergency Patient: ' + esc(em.patientName) + ' (' + em.patientId + ')</strong> · Scheduled at ' + em.time + '<br><small class="muted">' + esc(em.emergencyNotes || 'Emergency consultation') + '</small></div>';
            }).join('') + '</div>' : '') +
            '</div>';
        }

        var timingStat = timing.isExtended ? timing.extendedEndTime + ' (+' + timing.extensionMinutes + 'm)' : '17:00';
        return alertBox + '<h2>Today' + typeBadge + '</h2><div class="stats">' +
          stat('Appointments', l.length) +
          stat('Emergencies', emergencies.length) +
          stat('Daily Timing', timingStat) +
          stat('Waiting', n('Checked in')) +
          stat('Completed', n('Completed')) +
          '</div><div class="card"><h3>Schedule</h3>' +
          apptTable(l, function (a) { return openAppt(a) ? '<button class="btn small primary" data-act="appt" data-status="Completed" data-id="' + a.id + '">Mark completed</button>' : ''; }) + '</div>';
      },
      patients: async function () {
        var l = await api('GET', '/patients');
        return '<h2>Patients</h2><div class="card"><label>Search by name or number<input id="pt-search" type="search" placeholder="e.g. Vikram or MH-24002"></label><div id="pt-list">' +
          l.map(function (p) {
            var v = p.latest;
            return '<details class="pt" data-q="' + esc((p.name + ' ' + p.id).toLowerCase()) + '"><summary><span><strong>' + esc(p.name) + '</strong> <span class="mono muted">' + p.id + '</span></span><span>' + (p.bed ? '<span class="pill">Bed ' + p.bed + '</span>' : '<span class="pill grey">Outpatient</span>') + '</span></summary><div class="dl">' +
              '<div><small class="muted">Age / sex</small><br>' + esc(p.age == null ? '-' : p.age) + ' / ' + esc(p.sex || '-') + '</div><div><small class="muted">Condition</small><br>' + esc(p.cond) + '</div><div><small class="muted">Allergies</small><br>' + esc(p.allergy) + '</div><div><small class="muted">Phone</small><br>' + esc(p.phone || '-') + '</div>' +
              '<div><small class="muted">Latest vitals</small><br>' + (v ? esc(v.bp) + ' · HR ' + v.hr + ' · ' + v.temp + ' °C · SpO₂ ' + v.spo2 + '% ' + flag(v) : 'None recorded') + '</div></div></details>';
          }).join('') + '</div></div>';
      },
      prescribe: async function () {
        var r = await Promise.all([api('GET', '/patients'), api('GET', '/prescriptions')]);
        var l = r[1].slice(0, 6);
        return '<h2>Write prescription</h2><div class="card"><form id="f-rx"><label>Patient<select id="rx-pt" required>' + patOpts(r[0]) + '</select></label><div class="fgrid"><label>Medicine and strength<input id="rx-drug" required maxlength="120" placeholder="e.g. Amoxicillin 500 mg"></label><label>How to take<input id="rx-dose" required maxlength="160" placeholder="e.g. 1 capsule, twice a day"></label><label>Days<input id="rx-days" type="number" min="1" max="365" value="5" required></label></div><label>Notes<input id="rx-notes" maxlength="200" placeholder="Optional"></label><div><button class="btn primary" type="submit">Save prescription</button></div></form></div>' +
          '<div class="card"><h3>Your recent prescriptions</h3>' + (l.length ? '<div class="scroll"><table><thead><tr><th>Patient</th><th>Medicine</th><th>Dose</th><th>Date</th></tr></thead><tbody>' + l.map(function (x) { return '<tr><td>' + esc(x.patientName) + '</td><td>' + esc(x.drug) + '</td><td>' + esc(x.dose) + ' · ' + x.days + ' days</td><td>' + fdate(x.date) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<p class="muted">None yet.</p>') + '</div>';
      },
      leaves: async function () {
        var leaves = await api('GET', '/leaves');
        var today = cfg.today;
        var upcoming = leaves.filter(function (l) { return l.date >= today; });
        var past = leaves.filter(function (l) { return l.date < today; });
        var typeBadge = (S && S.doctorType) ? ' <span class="type-badge ' + S.doctorType + '">' + (S.doctorType === 'visiting' ? 'Visiting Doctor' : 'Regular Doctor') + '</span>' : '';
        return '<h2>My Leaves' + typeBadge + '</h2>' +
          '<div class="card">' +
          '<h3>Mark a leave day</h3>' +
          '<form id="f-leave">' +
          '<div class="fgrid">' +
          '<label>Date<input id="lv-date" type="date" min="' + today + '" required></label>' +
          '<label>Reason <span class="muted">(optional)</span><input id="lv-reason" maxlength="200" placeholder="e.g. Personal, Conference…"></label>' +
          '</div>' +
          '<div style="margin-top:12px"><button class="btn primary" type="submit">Mark leave</button></div>' +
          '</form>' +
          '</div>' +
          '<div class="card"><h3>Upcoming leaves (' + upcoming.length + ')</h3>' +
          (upcoming.length
            ? '<div class="scroll"><table><thead><tr><th>Date</th><th>Day</th><th>Reason</th><th></th></tr></thead><tbody>' +
            upcoming.map(function (l) {
              return '<tr><td><strong>' + fdate(l.date) + '</strong></td>' +
                '<td class="muted">' + dayName(l.date) + '</td>' +
                '<td>' + esc(l.reason || '—') + '</td>' +
                '<td><button class="btn small danger" data-act="del-leave" data-id="' + l.id + '">Remove</button></td></tr>';
            }).join('') +
            '</tbody></table></div>'
            : '<p class="muted">No upcoming leaves marked.</p>') +
          '</div>' +
          (past.length ? '<div class="card"><h3>Past leaves</h3><div class="scroll"><table><thead><tr><th>Date</th><th>Day</th><th>Reason</th></tr></thead><tbody>' +
            past.map(function (l) {
              return '<tr><td>' + fdate(l.date) + '</td><td class="muted">' + dayName(l.date) + '</td><td>' + esc(l.reason || '—') + '</td></tr>';
            }).join('') +
            '</tbody></table></div></div>' : '');
      },
    },

    admin: {
      overview: async function () {
        var s = await api('GET', '/admin/stats');
        var banner = s.pendingUsers ? '<div class="banner"><span><strong>' + s.pendingUsers + '</strong> staff account' + (s.pendingUsers > 1 ? 's are' : ' is') + ' waiting for approval.</span><button class="btn small" data-act="tab" data-tab="people">Review</button></div>' : '';
        return '<h2>Overview</h2>' + banner + '<div class="stats">' +
          stat('Patients on record', s.patients) +
          stat('Bed occupancy', Math.round(s.beds.used / s.beds.total * 100) + '%') +
          stat('Available beds', (s.beds.total - s.beds.used)) +
          stat('Appointments today', s.appointmentsToday) +
          '</div>' +
          '<div class="card"><h3>Occupancy by ward</h3>' + s.wards.map(function (w) { return '<div class="bar"><span>' + esc(w.name) + '</span><i><u data-w="' + Math.round(w.used / w.total * 100) + '"></u></i><span class="mono">' + w.used + '/' + w.total + '</span></div>'; }).join('') + '</div>';
      },
      register: async function () {
        var l = (await api('GET', '/patients')).slice(-5).reverse();
        return '<h2>Register patient</h2><div class="card"><form id="f-newpatient"><div class="fgrid"><label>Full name<input id="np-name" required maxlength="100"></label><label>Age<input id="np-age" type="number" min="0" max="120" required></label><label>Sex<select id="np-sex"><option>F</option><option>M</option><option>Other</option></select></label><label>Phone<input id="np-phone" type="tel" required maxlength="30"></label></div><label>Known allergies<input id="np-allergy" maxlength="200" placeholder="Leave blank if none known"></label><div><button class="btn primary" type="submit">Register</button></div></form></div>' +
          '<div class="card"><h3>Recently registered</h3><div class="scroll"><table><thead><tr><th>Number</th><th>Name</th><th>Age</th><th>Phone</th></tr></thead><tbody>' + l.map(function (p) { return '<tr><td class="mono">' + p.id + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.age == null ? '-' : p.age) + '</td><td>' + esc(p.phone || '-') + '</td></tr>'; }).join('') + '</tbody></table></div></div>';
      },
      desk: async function () {
        var l = await api('GET', '/appointments');
        var emergencies = l.filter(function (a) { return a.date === cfg.today && a.isEmergency; });
        return '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:14px">' +
          '<div><h2 style="margin:0">Appointments</h2><span class="muted" style="font-size:.85rem">Real-time patient bookings, walk-ins, and emergency triage</span></div>' +
          '<button type="button" class="btn danger pulse" data-act="open-admin-emergency-modal" style="font-weight:700">🚨 Book Emergency Slot (Walk-In Patient)</button>' +
          '</div>' +
          (emergencies.length ? '<div style="background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.25);border-left:5px solid #DC2626;border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:.88rem">🚨 <strong>' + emergencies.length + ' Emergency Slot' + (emergencies.length > 1 ? 's' : '') + ' Active Today</strong> — Walk-in/arrival emergency priority in effect. Doctor timings extended.</div>' : '') +
          '<div class="card">' + apptTable(l, function (a) {
            var b = '';
            if (a.status === 'Booked') b += '<button class="btn small primary" data-act="appt" data-status="Checked in" data-id="' + a.id + '">Check in</button> ';
            if (openAppt(a)) b += '<button class="btn small danger" data-act="appt" data-status="Cancelled" data-id="' + a.id + '">Cancel</button> ';
            if (a.status === 'Booked' || a.status === 'Cancelled') b += '<button class="btn small" data-act="reschedule" data-id="' + a.id + '">Reschedule</button>';
            return b;
          }) + '</div>';
      },
      beds: async function () {
        var r = await Promise.all([api('GET', '/patients'), api('GET', '/beds')]);
        var out = r[0].filter(function (p) { return !p.bed; }), adm = r[0].filter(function (p) { return p.bed; });
        var free = [];
        r[1].forEach(function (w) { w.beds.forEach(function (b) { if (!b.patient) free.push(b.id); }); });
        return '<h2>Admissions</h2><div class="card"><h3>Admit a patient</h3><form id="f-admit"><div class="fgrid"><label>Patient<select id="ad-pt" required>' + patOpts(out) + '</select></label><label>Free bed<select id="ad-bed" required><option value="">Select bed</option>' + free.map(function (b) { return '<option>' + b + '</option>'; }).join('') + '</select></label><label>Reason<input id="ad-cond" required maxlength="200" placeholder="Diagnosis or reason"></label></div><div><button class="btn primary" type="submit">Admit</button></div></form></div>' +
          '<div class="card"><h3>Admitted now (' + adm.length + ')</h3><div class="scroll"><table><thead><tr><th>Bed</th><th>Patient</th><th>Condition</th><th></th></tr></thead><tbody>' + adm.map(function (p) { return '<tr><td class="mono">' + p.bed + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.cond) + '</td><td><button class="btn small" data-act="discharge" data-id="' + p.id + '">Discharge</button></td></tr>'; }).join('') + '</tbody></table></div></div><div class="card"><h3>Bed map</h3>' + wardBoard(r[1]) + '</div>';
      },
      people: async function () {
        var r = await Promise.all([api('GET', '/admin/stats'), api('GET', '/admin/users')]);
        var allUsers = r[1];
        var st = { active: 'ok', pending: 'warn', disabled: 'crit' };

        var docUsers = allUsers.filter(function (u) { return u.role === 'doctor'; });
        var patUsers = allUsers.filter(function (u) { return u.role === 'patient'; });
        var admUsers = allUsers.filter(function (u) { return u.role === 'admin'; });

        function fmtGender(g) {
          return g === 'F' ? 'Female' : g === 'M' ? 'Male' : (g || '—');
        }
        function userRow(u, sec, showDept) {
          var self = u.id === S.id, btn = '';
          if (!self) {
            if (u.status !== 'active') btn += '<button class="btn small primary" data-act="user" data-status="active" data-id="' + u.id + '">' + (u.status === 'pending' ? 'Approve' : 'Re-enable') + '</button> ';
            if (u.status !== 'disabled') btn += '<button class="btn small danger" data-act="user" data-status="disabled" data-id="' + u.id + '">' + (u.status === 'pending' ? 'Reject' : 'Disable') + '</button>';
          }
          var qStr = (u.name + ' ' + u.email + ' ' + fmtGender(u.gender) + ' ' + (u.dept || '') + ' ' + u.status + ' ' + (u.google ? 'google' : 'email')).toLowerCase();
          return '<tr class="people-row" data-sec="' + sec + '" data-q="' + esc(qStr) + '">' +
            '<td><strong>' + esc(u.name) + '</strong>' + (self ? ' <span class="muted small">(You)</span>' : '') + '</td>' +
            '<td>' + esc(u.email) + '</td>' +
            '<td>' + esc(fmtGender(u.gender)) + '</td>' +
            (showDept ? '<td>' + esc(u.dept || 'General') + '</td>' : '') +
            '<td>' + (u.google ? '<span class="pill grey">Google</span>' : '<span class="pill grey">Email</span>') + '</td>' +
            '<td><span class="pill ' + (st[u.status] || 'grey') + '">' + u.status + '</span></td>' +
            '<td>' + btn + '</td></tr>';
        }

        var searchCard = '<div class="card people-search-box">' +
          '<div class="people-search-wrap">' +
          '<div class="people-search-input">' +
          '<label for="people-search" style="font-weight:600;margin-bottom:6px;display:block;">Search people &amp; accounts</label>' +
          '<input id="people-search" type="search" placeholder="Search by name, email, department, role, or status (e.g. Meera, Cardiology, active)..." value="' + esc(peopleSearchQuery) + '" autocomplete="off">' +
          '</div>' +
          '<div id="people-filter-stats" class="muted small" style="margin-top:18px;"></div>' +
          '</div>' +
          '</div>';

        var docCard = '<div class="card people-section" data-section="doctor">' +
          '<h3>Doctors (<span class="sec-cnt" id="cnt-doctor">' + docUsers.length + '</span>)</h3>' +
          '<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Gender</th><th>Department</th><th>Sign-in</th><th>Status</th><th></th></tr></thead><tbody class="people-table-body">' +
          (docUsers.length ? docUsers.map(function (u) { return userRow(u, 'doctor', true); }).join('') : '<tr><td colspan="7" class="muted center" style="text-align:center;padding:16px;">No doctor accounts registered.</td></tr>') +
          '<tr class="no-match-row" id="no-match-doctor" hidden><td colspan="7" class="muted center" style="text-align:center;padding:16px;">No doctor accounts match your search.</td></tr>' +
          '</tbody></table></div></div>';

        var patCard = '<div class="card people-section" data-section="patient">' +
          '<h3>Patients (<span class="sec-cnt" id="cnt-patient">' + patUsers.length + '</span>)</h3>' +
          '<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Gender</th><th>Sign-in</th><th>Status</th><th></th></tr></thead><tbody class="people-table-body">' +
          (patUsers.length ? patUsers.map(function (u) { return userRow(u, 'patient', false); }).join('') : '<tr><td colspan="6" class="muted center" style="text-align:center;padding:16px;">No patient accounts registered.</td></tr>') +
          '<tr class="no-match-row" id="no-match-patient" hidden><td colspan="6" class="muted center" style="text-align:center;padding:16px;">No patient accounts match your search.</td></tr>' +
          '</tbody></table></div></div>';

        var admCard = '<div class="card people-section" data-section="admin">' +
          '<h3>Administrators (<span class="sec-cnt" id="cnt-admin">' + admUsers.length + '</span>)</h3>' +
          '<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Gender</th><th>Sign-in</th><th>Status</th><th></th></tr></thead><tbody class="people-table-body">' +
          (admUsers.length ? admUsers.map(function (u) { return userRow(u, 'admin', false); }).join('') : '<tr><td colspan="6" class="muted center" style="text-align:center;padding:16px;">No administrator accounts registered.</td></tr>') +
          '<tr class="no-match-row" id="no-match-admin" hidden><td colspan="6" class="muted center" style="text-align:center;padding:16px;">No administrator accounts match your search.</td></tr>' +
          '</tbody></table></div></div>';

        var rosterCard = '<div class="card people-section" data-section="roster">' +
          '<h3>Doctor Roster &amp; Schedule (<span class="sec-cnt" id="cnt-roster">' + r[0].doctors.length + '</span>)</h3>' +
          '<div class="scroll"><table><thead><tr><th>Name</th><th>Department</th><th>Type</th><th class="num">Today</th></tr></thead><tbody class="people-table-body">' +
          (r[0].doctors.length ? r[0].doctors.map(function (d) {
            var qStr = (d.name + ' ' + d.dept + ' ' + (d.type || 'regular')).toLowerCase();
            return '<tr class="people-row" data-sec="roster" data-q="' + esc(qStr) + '"><td>' + esc(d.name) + '</td><td>' + esc(d.dept) + '</td><td>' + (d.type || 'regular') + '</td><td class="num">' + d.today + '</td></tr>';
          }).join('') : '<tr><td colspan="4" class="muted center" style="text-align:center;padding:16px;">No doctors available.</td></tr>') +
          '<tr class="no-match-row" id="no-match-roster" hidden><td colspan="4" class="muted center" style="text-align:center;padding:16px;">No doctors match your search.</td></tr>' +
          '</tbody></table></div></div>';

        return '<h2>People</h2>' + searchCard + docCard + patCard + admCard + rosterCard;
      },
      depts: async function () {
        var s = await api('GET', '/admin/stats');
        return '<h2>Departments</h2><div class="card"><div class="scroll"><table><thead><tr><th>Department</th><th class="num">Doctors</th><th class="num">Appointments today</th></tr></thead><tbody>' + s.departments.map(function (d) {
          return '<tr><td>' + esc(d.name) + '</td><td class="num">' + d.doctors + '</td><td class="num">' + d.appointmentsToday + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
      },
    },
  };

  /* ---------- app shell ---------- */
  async function refreshNotifications() {
    var nw = $('#notif-wrap');
    if (!S || (S.role !== 'patient' && S.role !== 'doctor')) {
      if (nw) nw.hidden = true;
      return null;
    }
    if (nw) nw.hidden = false;
    try {
      var isDoc = S.role === 'doctor';
      var data = await api('GET', isDoc ? '/doctor/notifications' : '/notifications');
      var badge = $('#notif-badge');
      if (badge) {
        if (data.unreadCount > 0) {
          badge.textContent = data.unreadCount;
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      }
      var popList = $('#notif-pop-list');
      if (popList) {
        if (data.notifications && data.notifications.length) {
          popList.innerHTML = data.notifications.map(function (n) {
            var icon = n.type === 'emergency_alert' ? '🚨' : n.type === 'emergency_delay' ? '⚠️' : n.type === 'missed' ? '⚠️' : n.type === '1_hour_before' ? '⏰' : n.type === 'day_of' ? '🗓' : '📅';
            var badgeText = n.type === 'emergency_alert' ? 'Emergency Alert' : n.type === 'emergency_delay' ? 'Emergency Delay' : n.type === 'missed' ? 'Missed Visit' : n.type === '1_hour_before' ? '1 Hour Before' : n.type === 'day_of' ? 'Day of Visit' : '1 Day Before';
            var badgeClass = (n.type === 'emergency_alert' || n.type === 'emergency_delay' || n.type === 'missed' || n.type === '1_hour_before') ? 'crit' : 'ok';
            return '<div class="notif-item' + (!n.read ? ' unread' : '') + '">' +
              '<div class="notif-item-top"><span class="pill ' + badgeClass + '">' + icon + ' ' + badgeText + '</span>' +
              '<small class="muted">' + esc(n.appt_time || '') + '</small></div>' +
              '<strong>' + esc(n.title) + '</strong>' +
              '<p>' + esc(n.message) + '</p>' +
              '</div>';
          }).join('');
        } else {
          popList.innerHTML = '<p class="muted" style="padding:14px;margin:0;font-size:.85rem;text-align:center">No active notifications.<br><small>' + (isDoc ? 'Emergency alerts and timing extensions appear here.' : 'Reminders and schedule updates appear here.') + '</small></p>';
        }
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  function renderNav() {
    var nav = $('#ap-nav'), def = ROLES[S.role].nav;
    nav.innerHTML = def.map(function (n) {
      return '<button class="' + (n[0] === tab ? 'active' : '') + '" data-act="tab" data-tab="' + n[0] + '">' + n[1] + '</button>';
    }).join('');
  }

  function applyPeopleFilter(q) {
    q = (q || '').trim().toLowerCase();
    var allRows = $$('.people-row');
    if (!allRows.length) return;
    var totalVisible = 0;
    allRows.forEach(function (tr) {
      var match = !q || (tr.dataset.q && tr.dataset.q.indexOf(q) >= 0);
      tr.hidden = !match;
      if (match) totalVisible++;
    });

    ['doctor', 'patient', 'admin', 'roster'].forEach(function (sec) {
      var secRows = $$('.people-row[data-sec="' + sec + '"]');
      var vis = secRows.filter(function (r) { return !r.hidden; }).length;
      var noMatch = $('#no-match-' + sec);
      if (noMatch) noMatch.hidden = (vis > 0 || !secRows.length);
      var cntEl = $('#cnt-' + sec);
      if (cntEl) {
        if (q) cntEl.textContent = vis + ' / ' + secRows.length;
        else cntEl.textContent = secRows.length;
      }
    });

    var statsEl = $('#people-filter-stats');
    if (statsEl) {
      if (q) statsEl.textContent = totalVisible + ' matching record' + (totalVisible === 1 ? '' : 's');
      else statsEl.textContent = '';
    }
  }

  async function renderApp(keepScroll) {
    renderSeq++;
    var seq = renderSeq;
    $('#ap-role').textContent = ROLES[S.role].label;
    $('#ap-name').innerHTML = esc(S.name) + (S.role === 'doctor' && S.doctorType ? ' <span class="type-badge ' + S.doctorType + '">' + (S.doctorType === 'visiting' ? 'Visiting' : 'Regular') + '</span>' : '');
    renderNav();
    refreshNotifications();
    var main = $('#ap-main');
    if (!keepScroll) main.innerHTML = '<div class="loading">Loading...</div>';
    try {
      if (!VIEWS[S.role] || !VIEWS[S.role][tab]) {
        tab = ROLES[S.role].nav[0][0];
        renderNav();
      }
      var html = await VIEWS[S.role][tab]();
      if (seq !== renderSeq) return;
      main.innerHTML = html;
      $$('[data-w]', main).forEach(function (u) { u.style.width = u.dataset.w + '%'; });
      if (tab === 'people' && S && S.role === 'admin' && peopleSearchQuery) {
        applyPeopleFilter(peopleSearchQuery);
      }
    } catch (e) {
      if (seq !== renderSeq) return;
      if (e.status === 401) return signedOut('Your session ended. Please sign in again.');
      main.innerHTML = '<div class="msg">' + esc(e.message) + '</div>';
    }
    if (!keepScroll && window.scrollY > 200) window.scrollTo(0, 0);
  }

  function signedOut(message) {
    S = null;
    var nw = $('#notif-wrap');
    if (nw) nw.hidden = true;
    var np = $('#notif-popover');
    if (np) np.hidden = true;
    closeRschedModal();
    $('#ap-main').innerHTML = '';
    show('landing');
    if (message) toast(message);
  }

  /* ---------- events ---------- */
  async function act(el) {
    var a = el.dataset.act, id = el.dataset.id;
    el.disabled = true;
    try {
      if (a === 'appt') { var x = await api('PATCH', '/appointments/' + id, { status: el.dataset.status }); toast('Appointment ' + x.status.toLowerCase()); }
      else if (a === 'discharge') { var p = await api('POST', '/patients/' + encodeURIComponent(id) + '/discharge'); toast(p.name + ' discharged'); }
      else if (a === 'user') { await api('POST', '/admin/users/' + id + '/status', { status: el.dataset.status }); toast(el.dataset.status === 'active' ? 'Account approved' : 'Account disabled'); }
      await renderApp(true);
    } catch (e) {
      el.disabled = false;
      if (e.status === 401) return signedOut('Your session ended. Please sign in again.');
      toast(e.message);
      renderApp(true);
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var a = el.dataset.act;

    if (a === 'jump') { var t = document.getElementById(el.dataset.to); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else if (a === 'pv') renderPreview(el.dataset.role);
    else if (a === 'role') openAuth(el.dataset.role);
    else if (a === 'back') show('landing');
    else if (a === 'auth-tab') setMode(el.dataset.mode);
    else if (a === 'google') {
      var defaultEmail = authRole + '@example.com';
      var email = window.prompt('Sign in with Google (' + ROLES[authRole].label + ' portal)\n\nEnter your Google email address:', defaultEmail);
      if (email && email.trim()) {
        var cleanEmail = email.trim().toLowerCase();
        var name = cleanEmail.split('@')[0];
        name = name.charAt(0).toUpperCase() + name.slice(1);
        onGoogle({ credential: cleanEmail + '|' + name });
      }
    }
    else if (a === 'signout') { api('POST', '/auth/logout').catch(function () { }).then(function () { signedOut(); }); }
    else if (a === 'tab') {
      tab = el.dataset.tab;
      if (tab !== 'people') peopleSearchQuery = '';
      // Reset booking state when switching to book tab
      if (tab === 'book') { bk.weekOffset = 0; bk.time = ''; }
      $('#ap-main').innerHTML = '';
      renderApp();
    }

    /* ---- booking calendar ---- */
    else if (a === 'pick-slot') {
      bk.time = el.dataset.slot;
      var inp = $('#bk-time');
      if (inp) inp.value = bk.time;
      $$('.slot-btn').forEach(function (b) { b.classList.toggle('selected', b.dataset.slot === bk.time); });
    }
    else if (a === 'pick-day') {
      bk.date = el.dataset.date;
      bk.time = '';
      renderApp(true);
    }
    else if (a === 'pick-visiting-date') {
      bk.date = el.dataset.date;
      bk.time = '';
      renderApp(true);
    }
    else if (a === 'quick-tomorrow') {
      bk.date = nextDate(cfg.today);
      bk.time = '';
      renderApp(true);
    }
    else if (a === 'bk-prev-week') {
      if (bk.weekOffset > 0) { bk.weekOffset--; bk.time = ''; renderApp(true); }
    }
    else if (a === 'bk-next-week') {
      bk.weekOffset++;
      bk.time = '';
      renderApp(true);
    }

    /* ---- reschedule modal ---- */
    else if (a === 'reschedule') {
      rsched.docId = '';
      rsched.date = '';
      rsched.time = '';
      rsched.weekOffset = 0;
      openRschedModal(el.dataset.id);
    }
    else if (a === 'close-modal') { closeRschedModal(); }
    else if (a === 'rs-pick-slot') {
      rsched.time = el.dataset.slot;
      var rsTime = $('#rs-time');
      if (rsTime) rsTime.value = rsched.time;
      $$('#rsched-overlay .slot-btn').forEach(function (b) { b.classList.toggle('selected', b.dataset.slot === rsched.time); });
      var submitBtn = $('#rsched-overlay button[type=submit]');
      if (submitBtn) submitBtn.disabled = !rsched.time;
    }
    else if (a === 'rs-pick-day') {
      rsched.date = el.dataset.date;
      rsched.time = '';
      getDoctors().then(redrawRschedModal);
    }
    else if (a === 'rs-pick-visiting-date') {
      rsched.date = el.dataset.date;
      rsched.time = '';
      getDoctors().then(redrawRschedModal);
    }
    else if (a === 'rs-prev-week') {
      if (rsched.weekOffset > 0) { rsched.weekOffset--; rsched.time = ''; getDoctors().then(redrawRschedModal); }
    }
    else if (a === 'rs-next-week') {
      rsched.weekOffset++;
      rsched.time = '';
      getDoctors().then(redrawRschedModal);
    }

    /* ---- emergency modal ---- */
    else if (a === 'open-emergency-modal') {
      openEmergencyModal(false);
    }
    else if (a === 'open-admin-emergency-modal') {
      openEmergencyModal(true);
    }
    else if (a === 'close-emergency-modal') {
      closeEmergencyModal();
    }
    else if (a === 'chip') {
      var reasonInp = $('#em-reason');
      if (reasonInp) reasonInp.value = el.dataset.val;
      $$('.symptom-chip').forEach(function (c) { c.classList.toggle('selected', c === el); });
    }

    else if (a === 'toggle-notifs') {
      var np = $('#notif-popover');
      if (np) {
        np.hidden = !np.hidden;
        if (!np.hidden) refreshNotifications();
      }
    }
    else if (a === 'mark-notifs-read') {
      var readUrl = (S && S.role === 'doctor') ? '/doctor/notifications/read-all' : '/notifications/read-all';
      api('POST', readUrl).then(function () {
        toast('All notifications marked as read');
        refreshNotifications();
        renderApp(true);
      }).catch(function (err) {
        toast(err.message);
      });
    }

    else if (a === 'appt' || a === 'discharge' || a === 'user') act(el);
    else if (a === 'del-leave') {
      el.disabled = true;
      api('DELETE', '/leaves/' + el.dataset.id).then(function () {
        toast('Leave removed');
        renderApp(true);
      }).catch(function (e) {
        el.disabled = false;
        toast(e.message);
      });
    }
  });

  document.addEventListener('click', function (e) {
    var pop = $('#notif-popover');
    if (pop && !pop.hidden && !e.target.closest('#notif-wrap')) {
      pop.hidden = true;
    }
  });

  document.addEventListener('change', async function (e) {
    var el = e.target;
    // Booking form selects
    if (el.dataset && el.dataset.bind) {
      bk[el.dataset.bind] = el.value;
      if (el.dataset.bind === 'dept') {
        if (doctorsCache) {
          var avail = doctorsCache.filter(function (d) { return !bk.dept || d.dept === bk.dept; });
          var ok = avail.some(function (d) { return String(d.id) === String(bk.doc); });
          if (!ok) bk.doc = avail.length ? String(avail[0].id) : '';
        }
        bk.time = '';
        bk.weekOffset = 0;
      }
      if (el.dataset.bind === 'doc') {
        bk.time = '';
        bk.weekOffset = 0;
        bk.date = (cfg.time && cfg.time >= '16:00') ? nextDate(cfg.today) : cfg.today;
      }
      renderApp(true);
    }
    // Reschedule modal doctor select
    if (el.id === 'r-doctype') {
      var showAvail = el.value === 'visiting';
      var avEl = $('#r-avail-l');
      if (avEl) avEl.hidden = !showAvail;
      return;
    }
    if (el.id === 'rs-doc') {
      rsched.docId = el.value;
      rsched.time = '';
      rsched.date = '';
      rsched.weekOffset = 0;
      getDoctors().then(redrawRschedModal);
    }
    if (el.id === 'em-pt-type') {
      var isWalkin = el.value === 'walkin';
      var wSec = $('#em-walkin-sec');
      var eSec = $('#em-existing-sec');
      if (wSec) wSec.hidden = !isWalkin;
      if (eSec) eSec.hidden = isWalkin;
      var emName = $('#em-name');
      var emPhone = $('#em-phone');
      if (emName) emName.required = isWalkin;
      if (emPhone) emPhone.required = isWalkin;
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'pt-search') {
      var q = e.target.value.trim().toLowerCase();
      $$('#pt-list details').forEach(function (d) { d.hidden = q && d.dataset.q.indexOf(q) < 0; });
    }
    if (e.target.id === 'people-search') {
      peopleSearchQuery = e.target.value;
      applyPeopleFilter(peopleSearchQuery);
    }
  });

  var val = function (id) { return $('#' + id).value.trim(); };

  document.addEventListener('submit', async function (e) {
    e.preventDefault();
    var form = e.target, id = form.id, btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      if (id === 'f-signin') {
        authMsg('');
        enter((await api('POST', '/auth/login', { role: authRole, email: val('s-email'), password: $('#s-pass').value })).user);
      } else if (id === 'f-register') {
        authMsg('');
        if ($('#r-pass').value !== $('#r-pass2').value) throw new Error('The two passwords do not match.');
        var genderVal = $('#r-gender') ? $('#r-gender').value : '';
        if (!genderVal) throw new Error('Please select a gender.');
        var body = { role: authRole, name: val('r-name'), email: val('r-email'), password: $('#r-pass').value, gender: genderVal };
        if (authRole === 'patient') {
          var ageRaw = $('#r-age') ? $('#r-age').value.trim() : '';
          if (ageRaw === '') throw new Error('Please enter your age.');
          body.age = Number(ageRaw);
          var phoneRaw = val('r-phone');
          if (!phoneRaw) throw new Error('Please enter your phone number.');
          body.phone = phoneRaw;
        }
        if (authRole === 'doctor') body.dept = $('#r-dept').value;
        if (authRole === 'doctor') {
          var docTypeVal = $('#r-doctype') ? $('#r-doctype').value : 'regular';
          body.type = docTypeVal;
          if (docTypeVal === 'visiting') {
            var checkedDays = $$('input[name="avail-day"]:checked').map(function (cb) { return cb.value; });
            if (!checkedDays.length) throw new Error('Select at least one available day for a visiting doctor.');
            body.availability = checkedDays;
          }
        }
        var out = await api('POST', '/auth/register', body);
        if (out.pending) pendingNotice(out.message);
        else { enter(out.user); toast('Account created'); }
      } else if (id === 'f-book') {
        var time = bk.time || val('bk-time');
        if (!bk.doc || !time) throw new Error('Pick a doctor and an available slot.');
        await api('POST', '/appointments', { doctorId: Number(bk.doc), date: bk.date, time: time });
        tab = 'home'; toast('Appointment booked for ' + time); await renderApp();
      } else if (id === 'f-emergency') {
        var emDocId = val('em-doc');
        var emReason = val('em-reason');
        if (!emDocId) throw new Error('Please select an on-duty doctor.');
        var payload = { doctorId: Number(emDocId), notes: emReason, reason: emReason };
        if (S.role === 'admin') {
          var ptType = $('#em-pt-type') ? $('#em-pt-type').value : 'existing';
          if (ptType === 'existing') {
            var exPt = val('em-existing-pt');
            if (!exPt) throw new Error('Please select an existing patient.');
            payload.patientId = exPt;
          } else {
            payload.name = val('em-name');
            payload.phone = val('em-phone');
            payload.age = $('#em-age') && $('#em-age').value ? Number($('#em-age').value) : undefined;
            payload.sex = $('#em-sex') ? $('#em-sex').value : undefined;
          }
        }
        var emRes = await api('POST', '/appointments/emergency', payload);
        closeEmergencyModal();
        toast(emRes.message || 'Emergency slot booked!');
        if (S.role === 'patient') tab = 'home';
        await renderApp(true);
      } else if (id === 'f-rsched') {
        var rsTime = $('#rs-time') ? $('#rs-time').value : rsched.time;
        if (!rsched.apptId || !rsTime) throw new Error('Pick a date and time slot.');
        var rsDoc = $('#rs-doc') ? $('#rs-doc').value : rsched.docId;
        await api('POST', '/appointments/' + rsched.apptId + '/reschedule', { doctorId: Number(rsDoc), date: rsched.date, time: rsTime });
        closeRschedModal();
        toast('Appointment rescheduled to ' + rsTime + ' on ' + fdate(rsched.date));
        await renderApp(true);
      } else if (id === 'f-leave') {
        await api('POST', '/leaves', { date: val('lv-date'), reason: val('lv-reason') || '' });
        toast('Leave marked for ' + fdate(val('lv-date'))); await renderApp(true);
      } else if (id === 'f-rx') {
        await api('POST', '/prescriptions', { patientId: val('rx-pt'), drug: val('rx-drug'), dose: val('rx-dose'), days: Number(val('rx-days')), notes: val('rx-notes') });
        toast('Prescription saved'); await renderApp(true);
      } else if (id === 'f-newpatient') {
        var np = await api('POST', '/patients', { name: val('np-name'), age: Number(val('np-age')), sex: $('#np-sex').value, phone: val('np-phone'), allergy: val('np-allergy') });
        toast('Registered as ' + np.id); await renderApp(true);
      } else if (id === 'f-admit') {
        var q = await api('POST', '/patients/' + encodeURIComponent(val('ad-pt')) + '/admit', { bed: val('ad-bed'), cond: val('ad-cond') });
        toast(q.name + ' admitted to ' + q.bed); await renderApp(true);
      }
    } catch (err) {
      if (id === 'f-signin' || id === 'f-register') authMsg(err.message);
      else if (err.status === 401) signedOut('Your session ended. Please sign in again.');
      else toast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  /* ---------- start ---------- */
  (async function init() {
    initLanding();
    try { cfg = await api('GET', '/config'); } catch (e) { toast('Cannot reach the server.'); }
    bk.date = cfg.today;
    try {
      var me = await api('GET', '/me');
      if (me && me.user) enter(me.user);
    } catch (e) { /* not signed in */ }
  })();
})();
