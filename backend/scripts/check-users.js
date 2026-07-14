require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { getPool, initSchema, pgEnabled } = require('../config/database');
const { SENSITIVE_USER_KEYS } = require('../utils/sanitizeUser');

async function main() {
  if (!pgEnabled()) {
    console.log('Postgres not enabled');
    process.exit(1);
  }
  await initSchema();
  const { rows } = await getPool().query(
    "SELECT id, data FROM documents WHERE collection = 'users'"
  );
  console.log('Users in DB:', rows.length);
  for (const row of rows) {
    const u = row.data || {};
    const leaked = SENSITIVE_USER_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(u, key));
    console.log(`- ${u.email} (${u.role}) id=${row.id} sensitiveKeys=${leaked.length ? leaked.join(',') : 'none'}`);
  }
  await getPool().end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
