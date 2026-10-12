// Local persistence in IndexedDB. Puzzle records hold metadata + board state;
// images are stored separately as raw bytes (more reliable than Blobs in Safari).

const DB_NAME = 'puzzle-table';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('puzzles', { keyPath: 'id' });
      db.createObjectStore('images');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  list: () => run('puzzles', 'readonly', (s) => s.getAll()),
  get: (id) => run('puzzles', 'readonly', (s) => s.get(id)),
  put: (rec) => run('puzzles', 'readwrite', (s) => s.put(rec)),
  async remove(id) {
    await run('puzzles', 'readwrite', (s) => s.delete(id));
    await run('images', 'readwrite', (s) => s.delete(id));
  },
  async putImage(id, blob) {
    const buf = await blob.arrayBuffer();
    return run('images', 'readwrite', (s) => s.put({ buf, type: blob.type }, id));
  },
  async getImage(id) {
    const v = await run('images', 'readonly', (s) => s.get(id));
    return v ? new Blob([v.buf], { type: v.type }) : null;
  },
};

// Ask the browser not to evict our data under storage pressure.
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
