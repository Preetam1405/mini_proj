# Meridian Hospital

A hospital management system with three role-based portals (patient, doctor, admin with integrated front desk operations), a Node.js API, and support for MySQL (XAMPP) or SQLite.

Flow: headline, app preview, choose a role, then Google authentication or email sign-in / registration, then that role's workspace.

## Database (XAMPP MySQL / MariaDB)

Meridian Hospital automatically detects and connects to **XAMPP MySQL / MariaDB** running in the background:
- **Host:** `127.0.0.1:3306` (or `/opt/lampp/var/mysql/mysql.sock`)
- **User:** `root` (default password: empty)
- **Database:** `meridian_hospital` (tables and demo sample data are auto-created on start)

Environment variables (optional overrides):
- `MYSQL_HOST` (default `127.0.0.1`)
- `MYSQL_PORT` (default `3306`)
- `MYSQL_USER` (default `root`)
- `MYSQL_PASSWORD` (default `""`)
- `MYSQL_DATABASE` (default `meridian_hospital`)
- `DB_DRIVER`: set to `sqlite` to force SQLite fallback or `mysql` to force MySQL.
- Unit and integration tests (`npm test`) run in-memory SQLite automatically for speed and complete test isolation.

## Run it

Requires Node.js 22.5 or newer.

```bash
npm start            # http://localhost:3000
npm test             # 20 API tests
```

Sample staff accounts created in development (password `Demo@12345`):

| Role | Email |
|---|---|
| Patient | patient@meridian.demo |
| Doctor | doctor@meridian.demo |
| Admin | admin@meridian.demo |

## What each role can do

| Role | Can do |
|---|---|
| Patient | Book and cancel own appointments, see own prescriptions and patient profile |
| Doctor | See own schedule, mark visits completed, view patients, record vitals, write prescriptions |
| Admin | Full hospital oversight: patient registration, appointments & check-in, admissions & bed map, staff approvals, and department figures |

Access is enforced on the server for every request.

## Authentication & Google Sign-In

Google Authentication is enabled across all portals (**Patient**, **Doctor**, and **Admin**):
- **Development/Local:** Click "Continue with Google" to sign in or register with any Google email immediately.
- **Production (Google Cloud):**
  1. In Google Cloud Console, create an OAuth client of type **Web application**.
  2. Add your site address (e.g. `http://localhost:3000` and your domain) under **Authorized JavaScript origins**.
  3. Set `GOOGLE_CLIENT_ID=<your client id>` in `.env`.
  4. Google Identity Services automatically renders the official Google sign-in button.

## Layout

```
server/
  index.js    starts the server
  app.js      routes, role checks, static files, security headers
  auth.js     password hashing, sessions, Google token check, rate limiter
  db.js       SQLite schema, first admin, sample data
  util.js     validation, wards, slots, dates
public/
  index.html  styles.css  app.js     the web app
test/
  api.test.js
```

## API

All paths start with `/api`. Responses are JSON. Errors look like `{ "error": "message" }`.

| Method and path | Who |
|---|---|
| `GET /config` | anyone |
| `POST /auth/register`, `/auth/login`, `/auth/google`, `/auth/logout` | anyone |
| `GET /me` | signed in |
| `GET /doctors`, `GET /slots?doctor=&date=` | signed in |
| `GET, POST /appointments`, `PATCH /appointments/:id` | by role |
| `GET /patients`, `POST /patients` | clinical staff, admin |
| `GET /patients/me` | patient |
| `POST /patients/:code/admit`, `/discharge` | admin |
| `POST /patients/:code/vitals` | doctor, admin |
| `GET /beds` | clinical staff, admin |
| `GET, POST /prescriptions` | patient, doctor, admin / doctor |
| `GET /admin/stats`, `GET /admin/users`, `POST /admin/users/:id/status` | admin |
