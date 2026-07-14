const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { admin } = require('../config/firebase');

async function testAuth() {
  try {
    const listUsersResult = await admin.auth().listUsers(10);
    console.log('Firebase Auth Connection Successful!');
    console.log(`Found ${listUsersResult.users.length} users in Firebase Authentication.`);
    listUsersResult.users.forEach(userRecord => {
      console.log(`- User: ${userRecord.email} (UID: ${userRecord.uid})`);
    });
  } catch (error) {
    console.error('Failed to list Firebase Auth users:', error);
  }
}

testAuth();
