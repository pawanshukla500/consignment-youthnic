const { db } = require('../config/firebase');

async function cleanup() {
  if (!db) {
    console.log('Firebase not available, nothing to clean');
    return;
  }

  const testIds = ['CON-001', 'CON-002', 'CON-003'];
  
  for (const id of testIds) {
    try {
      const doc = await db.collection('consignments').doc(id).get();
      if (doc.exists) {
        const data = doc.data();
        
        if (data.skuIds) {
          for (const skuId of data.skuIds) {
            await db.collection('skus').doc(skuId).delete();
            console.log(`Deleted SKU: ${skuId}`);
          }
        }
        
        if (data.boxIds) {
          for (const boxId of data.boxIds) {
            await db.collection('boxes').doc(boxId).delete();
            console.log(`Deleted box: ${boxId}`);
          }
        }
        
        if (data.videoIds) {
          for (const vidId of data.videoIds) {
            await db.collection('videos').doc(vidId).delete();
            console.log(`Deleted video: ${vidId}`);
          }
        }
        
        if (data.documentIds) {
          for (const docId of data.documentIds) {
            await db.collection('documents').doc(docId).delete();
            console.log(`Deleted document: ${docId}`);
          }
        }
        
        const scanSnap = await db.collection('scan_records').where('consignmentId', '==', id).get();
        for (const doc of scanSnap.docs) {
          await doc.ref.delete();
          console.log(`Deleted scan record: ${doc.id}`);
        }
        
        await db.collection('consignments').doc(id).delete();
        console.log(`Deleted consignment: ${id}`);
      } else {
        console.log(`Consignment not found: ${id}`);
      }
    } catch (error) {
      console.error(`Error deleting ${id}:`, error.message);
    }
  }
  
  console.log('Cleanup complete');
  process.exit(0);
}

cleanup();
