/**
 * storage.js —— IndexedDB 封装（原生 API 的 Promise 包装，零依赖）
 * -------------------------------------------------------------
 * 数据库名 `mobi-reader`（遵循 ReadMe 要求），三个对象仓库：
 *   books       keyPath=id     键为书籍 ID 哈希
 *   annotations keyPath=id 自增  含 bookId 索引
 *   settings    keyPath=key    键值对存储用户偏好
 */
'use strict';

const Storage = (() => {
  const DB_NAME = 'mobi-reader';
  const DB_VERSION = 1;
  let dbPromise = null;

  /** 打开（或升级）数据库 */
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('books')) {
            db.createObjectStore('books', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('annotations')) {
            const store = db.createObjectStore('annotations', {
              keyPath: 'id',
              autoIncrement: true,
            });
            store.createIndex('bookId', 'bookId', { unique: false });
          }
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('无法打开 IndexedDB'));
      });
    }
    return dbPromise;
  }

  /**
   * 单仓库单请求的通用执行器。
   * @param {string} storeName 仓库名
   * @param {string} mode      'readonly' | 'readwrite'
   * @param {(store:IDBObjectStore)=>IDBRequest} makeRequest 由调用方发起请求
   * @returns {Promise<any>} resolve 为请求结果
   */
  function run(storeName, mode, makeRequest) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      let result;
      t.oncomplete = () => resolve(result); // 事务完成后再返回，保证写入落盘
      t.onerror = t.onabort = () => reject(t.error);
      try {
        const request = makeRequest(t.objectStore(storeName));
        request.onsuccess = () => { result = request.result; };
        request.onerror = e => { e.preventDefault(); reject(request.error); };
      } catch (err) {
        reject(err);
      }
    }));
  }

  /* ------------------------------ books ------------------------------ */

  const getBook    = id => run('books', 'readonly', s => s.get(id));
  const getAllBooks = () => run('books', 'readonly', s => s.getAll());
  const putBook    = book => run('books', 'readwrite', s => s.put(book));
  const deleteBook = id => run('books', 'readwrite', s => s.delete(id));

  /* ---------------------------- annotations --------------------------- */

  /** 某书的全部标注，按创建时间升序 */
  async function getAnnotationsByBook(bookId) {
    const list = await run('annotations', 'readonly',
      s => s.index('bookId').getAll(bookId));
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }
  const addAnnotation    = data => run('annotations', 'readwrite', s => s.add(data)); // 返回自增 id
  const updateAnnotation = a    => run('annotations', 'readwrite', s => s.put(a));
  const deleteAnnotation = id   => run('annotations', 'readwrite', s => s.delete(id));

  /* ------------------------------ settings ----------------------------- */

  async function getSetting(key, defaultValue) {
    const row = await run('settings', 'readonly', s => s.get(key));
    return row === undefined ? defaultValue : row.value;
  }
  const setSetting = (key, value) =>
    run('settings', 'readwrite', s => s.put({ key, value }));

  /* -------------------------------- 清库 -------------------------------- */

  /** 删除书籍及其全部标注（书架删除时调用），不清空用户设置 */
  async function removeBookCompletely(bookId) {
    await deleteBook(bookId);
    const list = await getAnnotationsByBook(bookId);
    await Promise.all(list.map(a => deleteAnnotation(a.id)));
  }

  function clearAll() {
    return Promise.all([
      run('books', 'readwrite', s => s.clear()),
      run('annotations', 'readwrite', s => s.clear()),
    ]);
  }

  return {
    getBook, getAllBooks, putBook, deleteBook,
    getAnnotationsByBook, addAnnotation, updateAnnotation, deleteAnnotation,
    removeBookCompletely,
    getSetting, setSetting, clearAll,
  };
})();
