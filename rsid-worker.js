// ======================================================================
// rsid-worker.js
// RSID変換をWeb Workerで実行するスクリプト
// - IndexedDBによるデータファイルの永続キャッシュ
// - 進捗通知によるプログレスバー連携
// ======================================================================

const CONFIG = {
    DATA_PATH: './data/',
    FILE_COUNT: 256,
    DB_NAME: 'RSIDCache',
    DB_VERSION: 1,
    STORE_NAME: 'files'
};

// --- IndexedDB 操作 ---

/**
 * IndexedDBを開く（なければ作成）
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(CONFIG.STORE_NAME)) {
                db.createObjectStore(CONFIG.STORE_NAME);
            }
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

/**
 * IndexedDBからデータを読み取る
 * @param {IDBDatabase} db
 * @param {string} key - ファイル名（例: "00.txt"）
 * @returns {Promise<string|null>}
 */
function readFromDB(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CONFIG.STORE_NAME, 'readonly');
        const store = tx.objectStore(CONFIG.STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * IndexedDBにデータを書き込む
 * @param {IDBDatabase} db
 * @param {string} key - ファイル名
 * @param {string} value - ファイル内容
 * @returns {Promise<void>}
 */
function writeToDB(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(CONFIG.STORE_NAME, 'readwrite');
        const store = tx.objectStore(CONFIG.STORE_NAME);
        const request = store.put(value, key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// --- メモリキャッシュ（Worker内、セッション中のみ） ---
const memoryCache = new Map();

/**
 * ファイルを取得する（メモリ → IndexedDB → fetch の順で探索）
 * @param {IDBDatabase} db
 * @param {string} fileName - ファイル名（例: "00.txt"）
 * @returns {Promise<string>}
 */
async function getFileContent(db, fileName) {
    // 1. メモリキャッシュ確認
    if (memoryCache.has(fileName)) {
        return memoryCache.get(fileName);
    }

    // 2. IndexedDB確認
    try {
        const cached = await readFromDB(db, fileName);
        if (cached) {
            memoryCache.set(fileName, cached);
            return cached;
        }
    } catch (e) {
        console.warn(`IndexedDB読み取りエラー (${fileName}):`, e);
    }

    // 3. ネットワークからfetch
    try {
        const response = await fetch(CONFIG.DATA_PATH + fileName);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const content = await response.text();

        // IndexedDBとメモリに保存
        memoryCache.set(fileName, content);
        try {
            await writeToDB(db, fileName, content);
        } catch (e) {
            console.warn(`IndexedDB書き込みエラー (${fileName}):`, e);
        }

        return content;
    } catch (e) {
        console.error(`ファイル取得失敗 (${fileName}):`, e);
        throw e;
    }
}

// --- RSID検索・変換ロジック ---

/**
 * 対象RSIDのグローバルインデックスを検索する
 * @param {IDBDatabase} db
 * @param {string} targetRsid
 * @param {Function} onProgress - 進捗コールバック
 * @returns {Promise<number>} インデックス（見つからない場合 -1）
 */
async function findRSIDIndex(db, targetRsid, onProgress) {
    let globalIndex = 0;
    for (let i = 0; i < CONFIG.FILE_COUNT; i++) {
        const fileName = i.toString(16).padStart(2, '0') + '.txt';

        // 進捗通知（ファイル単位）
        if (onProgress) {
            onProgress(i, CONFIG.FILE_COUNT);
        }

        let content;
        try {
            content = await getFileContent(db, fileName);
        } catch (e) {
            continue;
        }

        const lines = content.split('\n');
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            const parts = line.split(/\s+/);
            const currentRsid = parts.length > 1 ? parts[1] : parts[0];
            if (currentRsid === targetRsid) {
                return globalIndex;
            }
            globalIndex++;
        }
    }
    return -1;
}

/**
 * グローバルインデックスから対応するRSID文字列を取得する
 * @param {IDBDatabase} db
 * @param {number} targetIndex
 * @returns {Promise<string|null>}
 */
async function getStringAtIndex(db, targetIndex) {
    let currentIndex = 0;
    for (let i = 0; i < CONFIG.FILE_COUNT; i++) {
        const fileName = i.toString(16).padStart(2, '0') + '.txt';

        let content;
        try {
            content = await getFileContent(db, fileName);
        } catch (e) {
            continue;
        }

        const lines = content.split('\n');
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            if (currentIndex === targetIndex) {
                const parts = line.split(/\s+/);
                return parts.length > 1 ? parts[1] : parts[0];
            }
            currentIndex++;
        }
    }
    return null;
}

/**
 * 16進数文字列をBigIntに変換
 * @param {string} hex
 * @returns {BigInt}
 */
function hexToBigInt(hex) {
    return BigInt('0x' + hex);
}

// --- メインスレッドからのメッセージ処理 ---
self.onmessage = async function (event) {
    const { type, leafNodes, playerIdHex } = event.data;

    if (type === 'convert') {
        let db;
        try {
            db = await openDB();
        } catch (e) {
            // IndexedDBが使えない場合はnullで続行（fetchのみ使用）
            console.warn('IndexedDBを開けませんでした。fetchのみで動作します:', e);
            db = null;
        }

        const idNum = Number(hexToBigInt(playerIdHex));
        const total = leafNodes.length;
        const results = [];

        for (let idx = 0; idx < total; idx++) {
            const node = leafNodes[idx];

            if (!node.id) {
                results.push({ uniqueId: node.uniqueId, newId: null });
                // 進捗通知
                self.postMessage({
                    type: 'progress',
                    current: idx + 1,
                    total: total,
                    message: `${idx + 1}/${total} ノード処理中...`
                });
                continue;
            }

            const targetRsid = node.id.replace(/_/g, '');

            // RSID検索（ファイル読み込み進捗も通知）
            self.postMessage({
                type: 'progress',
                current: idx,
                total: total,
                message: `${idx + 1}/${total} ノード: RSIDを検索中...`
            });

            const rsidIndex = await findRSIDIndex(db, targetRsid, (fileIdx, fileTotal) => {
                // ファイル読み込み進捗（細かい粒度）- 5ファイルごとに通知
                if (fileIdx % 5 === 0) {
                    self.postMessage({
                        type: 'progress',
                        current: idx,
                        total: total,
                        message: `${idx + 1}/${total} ノード: ファイル ${fileIdx}/${fileTotal} 検索中...`
                    });
                }
            });

            if (rsidIndex === -1) {
                console.warn(`RSID '${targetRsid}' が見つかりませんでした。`);
                results.push({ uniqueId: node.uniqueId, newId: null });
            } else {
                // プレイヤーIDによる変換計算
                let newIndex = 0;
                newIndex |= (0x100 + (rsidIndex & 0xff) - (idNum & 0xff)) & 0xff;
                newIndex |= ((0x10000 + (rsidIndex & 0xff00) - (idNum & 0xff00)) & 0xff00);
                newIndex |= ((0x1000000 + (rsidIndex & 0xff0000) - (idNum & 0xff0000)) & 0xff0000);

                const newRsidString = await getStringAtIndex(db, newIndex);
                results.push({
                    uniqueId: node.uniqueId,
                    newId: newRsidString || null
                });
            }

            // ノード完了の進捗通知
            self.postMessage({
                type: 'progress',
                current: idx + 1,
                total: total,
                message: `${idx + 1}/${total} ノード完了`
            });
        }

        // 全処理完了
        self.postMessage({
            type: 'result',
            convertedNodes: results
        });

        // DBを閉じる
        if (db) {
            db.close();
        }
    }
};
