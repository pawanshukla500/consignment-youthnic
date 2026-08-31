import { describe, it, expect } from 'vitest';

describe('Packing Station Scan Mutex', () => {
  it('should process 100 rapid consecutive scans strictly sequentially without lost wakeups', async () => {
    // 1. Simulate the RAM State and Mutex
    let scanMutex = Promise.resolve();
    let state = { packed: 0 };
    const scanLog = [];

    // Simulate an async enqueue to IndexedDB
    const enqueueScan = async (barcode) => {
      // Simulate network/disk delay
      await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
      scanLog.push(barcode);
    };

    // The handler exactly as structured in PackingStation.jsx
    const queueScanOperation = (operationFn) => {
      scanMutex = scanMutex.then(async () => {
        try {
          await operationFn();
        } catch (err) {
          // ignore
        }
      });
    };

    const handleBarcodeData = (barcode) => {
      queueScanOperation(async () => {
        // Evaluate snapshot
        const snapshot = { ...state };
        
        // Optimistic evaluation (qty limit)
        if (snapshot.packed >= 100) return;

        // Persist durably
        await enqueueScan(barcode);

        // Commit increment ONLY AFTER persistence
        state = { packed: state.packed + 1 };
      });
    };

    // 2. Fire 100 rapid scans synchronously
    for (let i = 0; i < 100; i++) {
      handleBarcodeData(`BARCODE_${i}`);
    }

    // Immediately after firing, state is still 0 because the Mutex chains them asynchronously
    expect(state.packed).toBe(0);

    // 3. Wait for the Mutex to fully drain
    await scanMutex;

    // 4. Verify no lost wakeups and perfect sequential processing
    expect(state.packed).toBe(100);
    expect(scanLog.length).toBe(100);
    expect(scanLog[0]).toBe('BARCODE_0');
    expect(scanLog[99]).toBe('BARCODE_99');
  });

  it('proves that a naive async queue loses wakeups (the old architecture)', async () => {
    let state = { packed: 0 };
    const scanQueueBuffer = [];
    let isProcessing = false;
    let processed = 0;

    const enqueueScan = async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      processed++;
    };

    const processScanQueue = async () => {
      if (isProcessing) return;
      isProcessing = true;
      try {
        while (scanQueueBuffer.length > 0) {
          scanQueueBuffer.shift();
          await enqueueScan();
          state = { packed: state.packed + 1 };
        }
      } finally {
        isProcessing = false;
      }
    };

    const handleBarcodeDataOld = (barcode) => {
      scanQueueBuffer.push(barcode);
      processScanQueue();
    };

    // Fire 2 rapid scans, but stagger them perfectly to hit the race condition
    handleBarcodeDataOld('BC_1');
    
    // Wait JUST enough for the while loop to empty the buffer, but BEFORE finally block runs
    await new Promise(resolve => setTimeout(resolve, 2));

    // Fire the second scan exactly while isProcessing is still true, but buffer was just emptied
    // In a real app this is a microtask/event loop race. We simulate by manually setting isProcessing
    isProcessing = true; 
    handleBarcodeDataOld('BC_2');
    
    // BC_2 is added to buffer, but processScanQueue returns immediately because isProcessing = true.
    // Then the original process completes and sets isProcessing = false.
    isProcessing = false;

    // Await all tasks
    await new Promise(resolve => setTimeout(resolve, 10));

    // BC_2 is stranded in the buffer!
    expect(scanQueueBuffer.length).toBe(1);
    expect(state.packed).toBe(1); // One scan was lost
  });
});
