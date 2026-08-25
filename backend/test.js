require('dotenv').config({ path: 'backend/.env' });
const { getPool } = require('./backend/config/database');
const c = require('./backend/utils/criticality');

async function test() {
  const pool = getPool();
  const res = await pool.query(`SELECT data FROM documents WHERE collection = 'consignments' AND data->>'status' != 'completed' AND data->>'operationalStatus' != 'archived'`);
  console.log('Active:', res.rows.length);
  
  let crits = 0;
  res.rows.forEach(r => {
    const crit = c.getShipmentCriticality(r.data);
    if (crit.level === 'critical' || crit.level === 'high') {
      console.log('At risk:', r.data.id, crit.level);
      crits++;
    }
  });
  console.log('Total at risk:', crits);
  process.exit();
}
test();
