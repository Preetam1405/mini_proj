'use strict';
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const { server, cfg, ready } = createApp();

if (cfg.production && !cfg.adminEmail && !process.env.SKIP_ADMIN_CHECK) {
  console.warn('Warning: set ADMIN_EMAIL and ADMIN_PASSWORD so the first administrator can be created.');
}

ready.then(() => {
  server.listen(port, () => {
    console.log(`Meridian Hospital running at http://localhost:${port}`);
    if (cfg.demo) console.log('Demo mode is on: sample data and demo accounts are available. Turn it off with DEMO_MODE=0.');
    if (!cfg.googleClientId) console.log('Google sign-in is off. Set GOOGLE_CLIENT_ID to turn it on.');
  });
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
