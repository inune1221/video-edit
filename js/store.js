// 編集内容の保存（端末内の IndexedDB）。素材のファイルも一緒に保存する
const DB = 'videdit';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
function tx(store, mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => (out = v));
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('aborted'));
  }));
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const putProject = (rec) => tx('projects', 'readwrite', (s) => s.put(rec));
export const getProject = (id) => tx('projects', 'readonly', (s) => req(s.get(id)));
export const listProjects = () => tx('projects', 'readonly', (s) => req(s.getAll())).then((l) => l.sort((a, b) => b.updated - a.updated));
export const putFile = (key, blob) => tx('files', 'readwrite', (s) => s.put(blob, key));
export const getFile = (key) => tx('files', 'readonly', (s) => req(s.get(key)));
export async function deleteProject(id) {
  await tx('projects', 'readwrite', (s) => s.delete(id));
  await tx('files', 'readwrite', (s) => s.delete(IDBKeyRange.bound(id + '/', id + '/￿')));
}
// 使える容量（目安）
export async function storageInfo() {
  try { const e = await navigator.storage.estimate(); return e; } catch { return null; }
}
export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
}
