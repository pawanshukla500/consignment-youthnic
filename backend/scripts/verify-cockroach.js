require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const variants = [
    'CREATE TRIGGER sync_documents_trigger AFTER INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION sync_documents_to_relational()',
    'CREATE TRIGGER sync_documents_trigger AFTER INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE PROCEDURE sync_documents_to_relational()',
  ];

  for (const sql of variants) {
    try {
      await pool.query('DROP TRIGGER IF EXISTS sync_documents_trigger ON documents');
      await pool.query(sql);
      console.log('TRIGGER OK:', sql.slice(0, 100));
      break;
    } catch (e) {
      console.log('TRIGGER FAIL:', e.message.split('\n')[0]);
    }
  }

  const id = `schema-test-${Date.now()}`;
  await pool.query(
    'INSERT INTO documents (collection, id, data) VALUES ($1, $2, $3::jsonb)',
    ['marketplaces', id, JSON.stringify({ name: 'Test Marketplace', code: 'TST' })]
  );
  const docs = await pool.query('SELECT count(*)::int AS n FROM documents');
  console.log('documents count:', docs.rows[0].n);
  await pool.query('DELETE FROM documents WHERE id = $1', [id]);

  // App connection helper path
  const { buildPoolConfig, resolveDatabaseUrl, validateDatabaseUrl } = require('../utils/dbConnection');
  const url = resolveDatabaseUrl();
  const validation = validateDatabaseUrl(url);
  console.log('provider:', validation.provider, 'sslMode prefer from build:');
  const cfg = buildPoolConfig(url);
  console.log('pool ssl enabled:', Boolean(cfg.ssl), 'url has sslmode=', String(cfg.connectionString).includes('sslmode=require') || String(cfg.connectionString).includes('verify'));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
