'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function openMysqlDb(config = {}) {
  const sab = new SharedArrayBuffer(16 * 1024 * 1024);
  const ctrl = new Int32Array(sab, 0, 4);
  const data = new Uint8Array(sab, 16);

  const worker = new Worker(path.join(__dirname, 'mysql-worker.js'), {
    workerData: {
      sab,
      config: {
        host: config.host || process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(config.port || process.env.MYSQL_PORT || 3306),
        user: config.user || process.env.MYSQL_USER || 'root',
        password: config.password ?? process.env.MYSQL_PASSWORD ?? '',
        database: config.database || process.env.MYSQL_DATABASE || 'meridian_hospital',
        socketPath: config.socketPath || (process.platform === 'linux' && require('node:fs').existsSync('/opt/lampp/var/mysql/mysql.sock') ? '/opt/lampp/var/mysql/mysql.sock' : undefined),
      },
    },
  });

  let isReady = false;
  let connectError = null;

  worker.on('message', (msg) => {
    if (msg.type === 'ready') isReady = true;
    if (msg.type === 'connect_error') connectError = new Error(msg.error);
  });

  worker.on('error', (err) => {
    connectError = err;
  });

  function sendSync(kind, sql, params = []) {
    if (connectError) throw connectError;
    const payload = Buffer.from(JSON.stringify({ kind, sql, params }));
    if (payload.length > data.length) throw new Error('Query payload exceeds maximum buffer size');

    data.set(payload);
    ctrl[1] = payload.length;
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0, 1);

    while (Atomics.load(ctrl, 0) !== 2 && Atomics.load(ctrl, 0) !== 3) {
      Atomics.wait(ctrl, 0, 1);
    }

    const len = ctrl[1];
    const isError = Atomics.load(ctrl, 0) === 3;
    Atomics.store(ctrl, 0, 0);

    const resStr = Buffer.from(data.buffer, 16, len).toString('utf8');
    const res = JSON.parse(resStr);
    if (isError) {
      const err = new Error(res.error);
      err.code = res.code;
      throw err;
    }
    return res;
  }

  Atomics.wait(ctrl, 2, 0, 3000);
  const connStatus = Atomics.load(ctrl, 2);
  if (connStatus !== 1) {
    worker.terminate();
    let msg = 'MySQL connection timed out or failed';
    if (connStatus === 2) {
      const len = ctrl[1];
      try {
        const errObj = JSON.parse(Buffer.from(data.buffer, 16, len).toString('utf8'));
        msg = errObj.error || msg;
      } catch {}
    }
    throw new Error(msg);
  }

  return {
    isMysql: true,
    exec(sql) {
      return sendSync('exec', sql);
    },
    prepare(sql) {
      return {
        get(...params) {
          const row = sendSync('get', sql, params);
          return row === null ? undefined : row;
        },
        all(...params) {
          return sendSync('all', sql, params) || [];
        },
        run(...params) {
          return sendSync('run', sql, params) || { lastInsertRowid: 0, changes: 0 };
        },
      };
    },
    close() {
      worker.terminate();
    },
  };
}

module.exports = { openMysqlDb };
