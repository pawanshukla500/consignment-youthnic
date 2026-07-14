const path = require('path');
const backendPath = 'c:/Users/shukl/Desktop/consignment-packing-master/backend';
require(path.join(backendPath, 'node_modules/dotenv')).config({ path: path.join(backendPath, '.env'), override: true });
const { Pool } = require(path.join(backendPath, 'node_modules/pg'));

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('No connection string found.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: connectionString.split('?')[0],
    ssl: { rejectUnauthorized: false }
  });

  try {
    // 1. Get all tables in public schema
    const tablesRes = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('Tables in public schema:', tablesRes.rows.map(r => r.table_name));

    // 2. Get triggers on documents table
    const triggersRes = await pool.query(`
      SELECT trigger_name, event_manipulation, action_statement
      FROM information_schema.triggers
      WHERE event_object_table = 'documents'
    `);
    console.log('Triggers on documents:', triggersRes.rows);

    // 3. Count rows in boxes table
    try {
      const boxesCount = await pool.query('SELECT COUNT(*) FROM public.boxes');
      console.log('Rows in boxes table:', boxesCount.rows[0].count);
    } catch (err) {
      console.log('Error counting boxes table:', err.message);
    }

    // 4. Count rows in consignments table
    try {
      const consCount = await pool.query('SELECT COUNT(*) FROM public.consignments');
      console.log('Rows in consignments table:', consCount.rows[0].count);
    } catch (err) {
      console.log('Error counting consignments table:', err.message);
    }

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
