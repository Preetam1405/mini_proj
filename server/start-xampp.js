'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOST = process.env.MYSQL_HOST || '127.0.0.1';
const PORT = Number(process.env.MYSQL_PORT || 3306);

function isPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function findXamppDir() {
  const candidates = [
    process.env.XAMPP_PATH,
    'D:\\xampp',
    'C:\\xampp',
    'E:\\xampp',
    'C:\\Program Files\\xampp',
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'mysql', 'bin', 'mysqld.exe'))) {
      return dir;
    }
  }
  return null;
}

async function ensureXamppMysql() {
  if (process.env.DB_DRIVER === 'sqlite') {
    return;
  }

  if (await isPortOpen(HOST, PORT)) {
    console.log(`XAMPP MySQL already running on ${HOST}:${PORT}.`);
    process.env.DB_DRIVER = 'mysql';
    return;
  }

  if (process.platform === 'win32') {
    const xamppDir = findXamppDir();
    if (!xamppDir) {
      console.warn('XAMPP installation not found (checked D:\\xampp, C:\\xampp, E:\\xampp). Set XAMPP_PATH if installed elsewhere.');
      return;
    }

    console.log(`Starting XAMPP MySQL from ${xamppDir}...`);
    const mysqld = path.join(xamppDir, 'mysql', 'bin', 'mysqld.exe');
    const child = spawn(mysqld, ['--defaults-file=mysql\\bin\\my.ini', '--standalone'], {
      cwd: xamppDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await isPortOpen(HOST, PORT)) {
        console.log(`XAMPP MySQL is ready on ${HOST}:${PORT}.`);
        process.env.DB_DRIVER = 'mysql';
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.warn('Timed out waiting for XAMPP MySQL to start.');
  }
}

ensureXamppMysql()
  .then(() => {
    require('./index');
  })
  .catch((err) => {
    console.error('Failed to start Meridian Hospital:', err);
    process.exit(1);
  });
