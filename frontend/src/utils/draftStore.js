const DATABASE_NAME = 'ai-subtitle-studio'
const DATABASE_VERSION = 1
const STORE_NAME = 'subtitle-drafts'

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('当前浏览器不支持 IndexedDB'))
      return
    }
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error || new Error('无法打开本地草稿数据库'))
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'taskId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

async function transaction(mode, operation) {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, mode)
      const request = operation(tx.objectStore(STORE_NAME))
      request.onerror = () => reject(request.error || new Error('本地草稿操作失败'))
      request.onsuccess = () => resolve(request.result)
      tx.onabort = () => reject(tx.error || new Error('本地草稿事务中止'))
    })
  } finally {
    database.close()
  }
}

export function getSubtitleDraft(taskId) {
  return transaction('readonly', (store) => store.get(taskId))
}

export function saveSubtitleDraft(taskId, subtitles, revision) {
  return transaction('readwrite', (store) => store.put({
    taskId,
    subtitles,
    revision,
    updatedAt: new Date().toISOString(),
  }))
}

export function deleteSubtitleDraft(taskId) {
  return transaction('readwrite', (store) => store.delete(taskId))
}
