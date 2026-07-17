/**
 * Await IndexedDB writes until the transaction commits.
 * Resolves only on transaction.oncomplete — never on request.onsuccess alone.
 */

/**
 * Run a readwrite (or readonly) IndexedDB transaction and wait for commit.
 *
 * @param {IDBDatabase} db
 * @param {string|string[]} storeNames
 * @param {'readonly'|'readwrite'} mode
 * @param {(stores: Record<string, IDBObjectStore>, tx: IDBTransaction) => Promise<any>|any} work
 */
export function withIdbTransaction(db, storeNames, mode, work) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames]
  return new Promise((resolve, reject) => {
    let settled = false
    let workResult
    let workError = null

    let tx
    try {
      tx = db.transaction(names, mode)
    } catch (err) {
      reject(err)
      return
    }

    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err || new Error('IndexedDB transaction failed'))
    }

    const succeed = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    tx.oncomplete = () => {
      if (workError) fail(workError)
      else succeed(workResult)
    }
    tx.onerror = () => fail(tx.error || new Error('IndexedDB transaction error'))
    tx.onabort = () => fail(tx.error || new Error('IndexedDB transaction aborted'))

    const stores = {}
    for (const name of names) {
      stores[name] = tx.objectStore(name)
    }

    Promise.resolve()
      .then(() => work(stores, tx))
      .then((result) => {
        workResult = result
      })
      .catch((err) => {
        workError = err
        try {
          tx.abort()
        } catch {
          fail(err)
        }
      })
  })
}

/** Wrap a single IDBRequest in a Promise (does not imply transaction commit). */
export function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
  })
}

/**
 * Pure helper used by tests: decide whether a write helper may resolve.
 * Only `complete` means persisted.
 */
export function isIdbWriteCommitted(eventType) {
  return eventType === 'complete'
}
