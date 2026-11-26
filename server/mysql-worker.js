'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const mysql = require('mysql2');

const { sab, config } = workerData;
const ctrl = new Int32Array(sab, 0, 4);
const data = new Uint8Array(sab, 16);

let conn = null;

function getConn(cb) {
  if (conn && conn.state !== 'disconnected') {
    return cb(null, conn);
  }
  const newConn = mysql.createConnection({
    host: config.host || '127.0.0.1',
    port: config.port || 3306,
    user: config.user || 'root',
    password: config.password || '',
    database: config.database || 'meridian_hospital',
    socketPath: config.socketPath,
    multipleStatements: true,
    dateStrings: true,
    enableKeepAlive: true,
  });
  newConn.on('error', (err) => {
    if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
      conn = null;
    }
  });
  newConn.connect((err) => {
    if (err) return cb(err);
    conn = newConn;
    cb(null, conn);
  });
}

function initDb(cb) {
  const initConn = mysql.createConnection({
    host: config.host || '127.0.0.1',
    port: config.port || 3306,
    user: config.user || 'root',
    password: config.password || '',
    socketPath: config.socketPath,
  });
  initConn.on('error', () => {});
  initConn.connect((err) => {
    if (err) return cb(err);
    const dbName = (config.database || 'meridian_hospital').replace(/`/g, '');
    initConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``, (qErr) => {
      initConn.end();
      if (qErr) return cb(qErr);
      getConn(cb);
    });
  });
}

function normalizeSql(sql) {
  let s = sql.trim();
  if (s.toUpperCase().startsWith('PRAGMA ')) return null;
  s = s.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO');
  s = s.replace(/\bBEGIN\s+IMMEDIATE\b/gi, 'START TRANSACTION');
  return s;
}

function sendResponse(status, payloadObj) {
  const buf = Buffer.from(JSON.stringify(payloadObj));
  data.set(buf);
  ctrl[1] = buf.length;
  Atomics.store(ctrl, 0, status);
  Atomics.notify(ctrl, 0, 1);
}

function sendQueryResult(kind, rows) {
  if (kind === 'run') {
    sendResponse(2, {
      lastInsertRowid: rows ? Number(rows.insertId || 0) : 0,
      changes: rows ? (rows.affectedRows || 0) : 0,
    });
  } else if (kind === 'get') {
    const row = Array.isArray(rows) ? (rows[0] !== undefined ? rows[0] : null) : null;
    sendResponse(2, row);
  } else {
    sendResponse(2, Array.isArray(rows) ? rows : []);
  }
}

function handleQuery(payloadStr) {
  const req = JSON.parse(payloadStr);
  const rawSql = req.sql;
  const sql = normalizeSql(rawSql);
  if (sql === null) {
    sendResponse(2, req.kind === 'run' ? { lastInsertRowid: 0, changes: 0 } : (req.kind === 'get' ? null : []));
    loop();
    return;
  }

  const params = req.params || [];
  getConn((err, connection) => {
    if (err) {
      sendResponse(3, { error: err.message, code: err.code });
      loop();
      return;
    }
    connection.query(sql, params, (qErr, rows) => {
      if (qErr && (qErr.code === 'ECONNRESET' || qErr.code === 'PROTOCOL_CONNECTION_LOST')) {
        conn = null;
        getConn((retryErr, retryConn) => {
          if (retryErr) {
            sendResponse(3, { error: retryErr.message, code: retryErr.code });
            loop();
            return;
          }
          retryConn.query(sql, params, (rErr, rRows) => {
            if (rErr) {
              sendResponse(3, { error: rErr.message, code: rErr.code });
            } else {
              sendQueryResult(req.kind, rRows);
            }
            loop();
          });
        });
        return;
      }
      if (qErr) {
        sendResponse(3, { error: qErr.message, code: qErr.code });
      } else {
        sendQueryResult(req.kind, rows);
      }
      loop();
    });
  });
}

function loop() {
  Atomics.wait(ctrl, 0, 0);
  if (Atomics.load(ctrl, 0) === 1) {
    const len = ctrl[1];
    const payloadStr = Buffer.from(data.buffer, 16, len).toString('utf8');
    handleQuery(payloadStr);
  } else {
    loop();
  }
}

initDb((err) => {
  if (err) {
    const errBuf = Buffer.from(JSON.stringify({ error: err.message, code: err.code }));
    data.set(errBuf);
    ctrl[1] = errBuf.length;
    Atomics.store(ctrl, 2, 2);
    Atomics.notify(ctrl, 2, 1);
    if (parentPort) parentPort.postMessage({ type: 'connect_error', error: err.message });
    return;
  }
  Atomics.store(ctrl, 2, 1);
  Atomics.notify(ctrl, 2, 1);
  if (parentPort) parentPort.postMessage({ type: 'ready' });
  loop();
});
