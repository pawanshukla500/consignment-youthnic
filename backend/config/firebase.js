const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let firebaseInitialized = false;
let credentialSource = 'none';
let serviceAccountMeta = null;
let initError = null;

const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'serviceAccountKey.json');

function validateServiceAccount(key) {
  return (
    key &&
    typeof key === 'object' &&
    key.type === 'service_account' &&
    key.project_id &&
    key.private_key &&
    key.private_key.includes('BEGIN PRIVATE KEY') &&
    key.client_email
  );
}

function parseServiceAccountRaw(raw) {
  let text = String(raw || '').trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    text = text.slice(1, -1);
  }
  const key = JSON.parse(text);
  if (key.private_key && typeof key.private_key === 'string') {
    key.private_key = key.private_key.replace(/\\n/g, '\n');
  }
  return key;
}

function loadServiceAccount() {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      try {
        const key = parseServiceAccountRaw(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        if (validateServiceAccount(key)) {
          credentialSource = 'env_json';
          serviceAccountMeta = {
            client_email: key.client_email,
            project_id: key.project_id,
          };
          return admin.credential.cert(key);
        }
        console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON failed validation.');
      } catch (e) {
        console.warn('[Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
        console.warn('[Firebase] Paste the full JSON on one line in backend/.env — use \\n inside private_key.');
      }
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const credPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
      if (fs.existsSync(credPath)) {
        try {
          const key = parseServiceAccountRaw(fs.readFileSync(credPath, 'utf8'));
          if (validateServiceAccount(key)) {
            credentialSource = 'file';
            serviceAccountMeta = {
              client_email: key.client_email,
              project_id: key.project_id,
            };
            return admin.credential.cert(key);
          }
        } catch (e) {
          console.warn('[Firebase] Invalid GOOGLE_APPLICATION_CREDENTIALS file:', e.message);
        }
      }
    }

    if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
      try {
        const key = parseServiceAccountRaw(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
        if (validateServiceAccount(key)) {
          credentialSource = 'serviceAccountKey.json';
          serviceAccountMeta = {
            client_email: key.client_email,
            project_id: key.project_id,
          };
          return admin.credential.cert(key);
        }
      } catch (e) {
        console.warn('[Firebase] Error parsing serviceAccountKey.json:', e.message);
      }
    }

    credentialSource = 'none';
    serviceAccountMeta = null;
    return null;
  } catch (error) {
    console.warn('[Firebase] Error loading service account:', error.message);
    credentialSource = 'none';
    return null;
  }
}

function shouldInitializeFirebase() {
  const credential = loadServiceAccount();
  if (credential) return { credential, reason: credentialSource };

  if (process.env.K_SERVICE || process.env.GOOGLE_CLOUD_PROJECT) {
    return { credential: null, reason: 'gcp_environment' };
  }

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return { credential: null, reason: 'emulator' };
  }

  return null;
}

function initializeFirebase() {
  if (admin.apps.length) return;

  const initConfig = shouldInitializeFirebase();
  if (!initConfig) {
    console.log('[Firebase] Not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON in backend/.env');
    return;
  }

  try {
    // Auth only — videos/documents use Cloudflare R2 (see config/r2.js).
    const config = {
      projectId: process.env.FIREBASE_PROJECT_ID || serviceAccountMeta?.project_id || 'consignment-packing-app',
    };

    if (initConfig.credential) {
      config.credential = initConfig.credential;
    }

    admin.initializeApp(config);
    firebaseInitialized = true;
    initError = null;

    console.log('[Firebase] Initialized successfully (Auth only)');
    console.log('[Firebase] Project:', config.projectId);
    console.log('[Firebase] Credentials:', initConfig.reason);
  } catch (error) {
    initError = error.message;
    firebaseInitialized = false;
    console.error('[Firebase] Initialization failed:', error.message);
  }
}

function getFirebaseStatus() {
  return {
    initialized: firebaseInitialized,
    credentialSource,
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccountMeta?.project_id || null,
    clientEmail: serviceAccountMeta?.client_email || null,
    authAvailable: Boolean(firebaseInitialized && admin?.auth),
    storageAvailable: false,
    initError,
    setupHint: firebaseInitialized
      ? null
      : 'Set FIREBASE_SERVICE_ACCOUNT_JSON in backend/.env (paste full service account JSON on one line).',
  };
}

initializeFirebase();

module.exports = {
  admin,
  firebaseInitialized,
  getFirebaseStatus,
};
