const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'serviceAccountKey.json');

let credential = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  credential = admin.credential.cert(process.env.GOOGLE_APPLICATION_CREDENTIALS);
} else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  credential = admin.credential.cert(SERVICE_ACCOUNT_PATH);
}

if (!credential) {
  console.error('No Firebase service account found.');
  process.exit(1);
}

admin.initializeApp({ credential });
const db = admin.firestore();

const PRESET_COMPANIES = [
  'Delhivery',
  'CargoSavvy',
  'Baral Logistics',
  'Instakart Services Private Limited',
  'Trispeed'
];

async function seed() {
  const snapshot = await db.collection('docketCompanies').get();
  const existing = new Set(snapshot.docs.map(d => d.data().name));

  const batch = db.batch();
  let added = 0;

  for (const name of PRESET_COMPANIES) {
    if (!existing.has(name)) {
      const ref = db.collection('docketCompanies').doc();
      batch.set(ref, { id: ref.id, name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      added++;
      console.log(`Adding: ${name}`);
    } else {
      console.log(`Skipping (exists): ${name}`);
    }
  }

  if (added > 0) {
    await batch.commit();
    console.log(`Committed ${added} new docket companies.`);
  } else {
    console.log('All preset companies already exist.');
  }
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
