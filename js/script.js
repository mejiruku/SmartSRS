import { createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { doc, getDoc, setDoc, collection, getDocs, deleteDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { auth, db } from "./firebase-init.js";

let appData = { decks: [] };
let currentUser = null;
let currentDeckId = null;
let studyQueue = [];
let currentCard = null;
let editingCardId = null;
let isCramMode = false;
let sessionReviewedIds = new Set();
let historyStack = [];

// --- 学習記録用の変数 ---
let sessionStartTime = null; 
let sessionCardsCount = 0;   

const STORAGE_KEY = 'smart_srs_v3'; 

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms));

onAuthStateChanged(auth, async (user) => {
    const authView = document.getElementById('auth-view');
    if (user) {
        // --- ログイン済みの処理 ---
        currentUser = user;
        document.getElementById('user-email-display').innerText = user.email;
        authView.style.display = 'none'; // 念のため非表示維持
        
        // CSSで最初からローディングが出ているので、showLoading(true)は実質不要ですが、
        // 処理の明示として残しておいても問題ありません。
        showLoading(true);

        try {
            await Promise.race([loadDataFromCloud(), timeout(10000)]);
        } catch (error) {
            console.error("読み込みエラー:", error);
            if (error.message === "TIMEOUT") {
                alert("通信がタイムアウトしました。");
            } else {
                alert("データの読み込みに失敗しました。");
            }
        }

        showLoading(false); // 読み込み完了したらローディングを消す
        switchView('deck-list-view');
        renderDeckList();
    } else {
        // --- 未ログインの処理 ---
        currentUser = null;
        document.querySelectorAll('.container').forEach(el => el.style.display = 'none');
        
        // ★ ここが重要：CSSで表示されっぱなしのローディング画面を消す
        showLoading(false);
        
        // その後、ログイン画面を表示する
        authView.style.display = 'flex';
    }
});

// --- Login Bypass (Test Mode) ---
let loginPressTimer;
const btnLogin = document.getElementById('btnLogin');

function startBypassTimer() {
    loginPressTimer = setTimeout(async () => {
        console.log("Bypassing login...");
        currentUser = { uid: 'test_user_' + Date.now(), isAnonymous: true, email: 'test@test.com' };
        alert("テストモードでログインしました (Bypass)");
        document.getElementById('user-email-display').innerText = 'Test User';
        document.getElementById('auth-view').style.display = 'none';
        initDefaultData();
        switchView('deck-list-view');
        renderDeckList();
    }, 5000);
}

function cancelBypassTimer() {
    clearTimeout(loginPressTimer);
}

btnLogin.addEventListener('mousedown', startBypassTimer);
btnLogin.addEventListener('touchstart', startBypassTimer);
btnLogin.addEventListener('mouseup', cancelBypassTimer);
btnLogin.addEventListener('mouseleave', cancelBypassTimer);
btnLogin.addEventListener('touchend', cancelBypassTimer);

btnLogin.addEventListener('click', async () => {
    if (!currentUser) await tryLogin(); 
});

async function tryLogin() {
    const email = document.getElementById('email').value;
    const pass = document.getElementById('password').value;
    const err = document.getElementById('auth-error');
    err.style.display = 'none';
    try { await signInWithEmailAndPassword(auth, email, pass); } catch (e) {
        err.innerText = "ログイン失敗: " + e.message;
        err.style.display = 'block';
    }
}

window.checkLoginEnter = (e) => {
    if(e.key === 'Enter') tryLogin();
};

document.getElementById('btnSignup').addEventListener('click', async () => {
    const email = document.getElementById('email').value;
    const pass = document.getElementById('password').value;
    const err = document.getElementById('auth-error');
    err.style.display = 'none';
    try { await createUserWithEmailAndPassword(auth, email, pass); alert("登録完了！"); } catch (e) {
        err.innerText = "登録失敗: " + e.message;
        err.style.display = 'block';
    }
});

window.handleLogout = () => signOut(auth);

window.resetPassword = async () => {
    const email = document.getElementById('email').value;
    if (!email) { alert('メールアドレスを入力してください'); return; }
    try {
        await sendPasswordResetEmail(auth, email);
        alert('パスワード再設定メールを送信しました');
    } catch (e) {
        alert('送信失敗: ' + e.message);
    }
};

async function loadDataFromCloud() {
    if (!currentUser) return;
    const decksCol = collection(db, "users", currentUser.uid, "decks");
    try {
        const snp = await getDocs(decksCol);
        if (!snp.empty) {
            appData.decks = snp.docs.map(d => d.data());
            appData.decks.sort((a, b) => (a.order || 0) - (b.order || 0));
            let changed = false;
            appData.decks.forEach((d, i) => {
                if (d.order === undefined) { d.order = i; changed = true; }
            });
            if (changed) { appData.decks.forEach(d => saveDeckToCloud(d)); }
        } else {
            const userDocRef = doc(db, "users", currentUser.uid);
            const docSnap = await getDoc(userDocRef);
            if (docSnap.exists() && docSnap.data().appData) {
                appData = docSnap.data().appData;
                appData.decks.forEach((d, i) => d.order = i);
                for (const deck of appData.decks) {
                    await saveDeckToCloud(deck);
                }
            } else {
                 initDefaultData();
            }
        }
    } catch (error) { console.error(error); alert("読込失敗"); }
}

async function saveDeckToCloud(deck) {
    if (!currentUser || !deck) return;
    try {
        await setDoc(doc(db, "users", currentUser.uid, "decks", deck.id), deck);
    } catch (e) { console.error(e); }
}

async function deleteDeckFromCloud(deckId) {
    if (!currentUser) return;
    try {
        await deleteDoc(doc(db, "users", currentUser.uid, "decks", deckId));
    } catch (e) { console.error(e); }
}

function initDefaultData() {
    appData = { decks: [] };
}

window.openSettings = () => { 
    switchView('settings-view'); 
    renderSettingsDeckList(); 
    const meta = document.querySelector('meta[name="data-app-version"]');
    if (meta) {
        document.getElementById('app-version').innerText = meta.content;
    }
};

// --- 学習終了時に記録を保存するように変更 ---
window.backToDecks = async () => { 
    if (sessionStartTime && sessionCardsCount > 0) {
        const duration = Math.floor((Date.now() - sessionStartTime) / 1000); 
        await saveStudyLog(sessionCardsCount, duration);
    }
    sessionStartTime = null;
    sessionCardsCount = 0;
    switchView('deck-list-view'); 
    renderDeckList(); 
    sessionReviewedIds.clear(); 
    historyStack = []; 
};

window.showAddDeckModal = () => document.getElementById('modal-deck').classList.add('active');
window.closeModals = () => document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));

window.createDeck = () => {
    const name = document.getElementById('new-deck-name').value;
    if(name) {
        const maxOrder = appData.decks.length > 0 ? Math.max(...appData.decks.map(d => d.order || 0)) : 0;
        const newDeck = { id:'d_'+Date.now(), name, cards:[], order: maxOrder + 1 };
        appData.decks.push(newDeck);
        saveDeckToCloud(newDeck); renderDeckList(); window.closeModals();
        document.getElementById('new-deck-name').value = '';
    }
};

// --- 学習開始時にセッション計測を開始 ---
window.openStudy = (id) => {
    currentDeckId = id; isCramMode = false; sessionReviewedIds.clear(); historyStack = [];
    sessionStartTime = Date.now(); 
    sessionCardsCount = 0;         
    const deck = appData.decks.find(d => d.id === id);
    if(!deck) return;
    document.getElementById('study-title').innerText = deck.name;
    window.sessionTotal = deck.cards.filter(c => c.dueDate <= Date.now()).length; 
    if(window.sessionTotal === 0 && deck.cards.length > 0) window.sessionTotal = deck.cards.length; 
    switchView('study-view'); refreshQueue();
};

window.openManager = () => { switchView('manager-view'); renderManagerList(); };
window.closeManager = () => { switchView('study-view'); refreshQueue(); };

// --- Deck Menu (Export/Import) ---
window.showDeckMenu = () => {
    document.getElementById('modal-deck-menu').classList.add('active');
    // リセット
    document.getElementById('import-text-area').value = '';
    document.getElementById('fileInput').value = '';
};

window.startCramMode = () => { 
    isCramMode = true; sessionReviewedIds.clear(); historyStack = []; 
    const deck = appData.decks.find(d => d.id === currentDeckId);
    window.sessionTotal = deck.cards.length;
    refreshQueue(); 
};

// --- カード回答時にカウントアップ ---
window.rateCard = (rating) => {
    if (!currentCard) return;
    sessionCardsCount++; 
    document.querySelectorAll('.rate-btn').forEach(btn => btn.disabled = true);
    
    const cardStateCopy = JSON.parse(JSON.stringify(currentCard));
    historyStack.push({ card: cardStateCopy, isCramMode: isCramMode });
    updateUndoButton();
    sessionReviewedIds.add(currentCard.id);
    const deck = appData.decks.find(d => d.id === currentDeckId);
    const idx = deck.cards.findIndex(c => c.id === currentCard.id);
    const next = calculateNextState(currentCard, rating);
    deck.cards[idx] = { ...currentCard, ...next };
    saveDeckToCloud(deck); refreshQueue();
};

window.handleUndo = () => {
    if (historyStack.length === 0) return;
    const prevState = historyStack.pop();
    const prevCard = prevState.card;
    const deck = appData.decks.find(d => d.id === currentDeckId);
    const idx = deck.cards.findIndex(c => c.id === prevCard.id);
    if (idx !== -1) deck.cards[idx] = prevCard;
    if (prevState.isCramMode) sessionReviewedIds.delete(prevCard.id);
    if (sessionCardsCount > 0) sessionCardsCount--; 
    saveDeckToCloud(deck); refreshQueue(); updateUndoButton();
};

function updateUndoButton() {
    const btn = document.getElementById('btnUndo');
    btn.disabled = (historyStack.length === 0);
    btn.style.opacity = (historyStack.length === 0) ? '0.3' : '1';
}

window.renderManagerList = renderManagerList;

window.openEditModal = (cardId) => {
    editingCardId = cardId;
    const deck = appData.decks.find(d => d.id === currentDeckId); 
    if (!deck) return;
    
    if (cardId) {
        const card = deck.cards.find(c => c.id === cardId);
        document.getElementById('modal-card-title').innerText = "カード編集";
        document.getElementById('edit-display-id').value = card.displayId || "";
        document.getElementById('edit-q').value = card.question;
        document.getElementById('edit-a').value = card.answer;
        document.getElementById('edit-e').value = card.explanation;
        document.getElementById('btn-delete').style.display = 'inline-block';
    } else {
        document.getElementById('modal-card-title').innerText = "新規カード追加";
        document.getElementById('edit-display-id').value = "";
        document.getElementById('edit-q').value = "";
        document.getElementById('edit-a').value = "";
        document.getElementById('edit-e').value = "";
        document.getElementById('btn-delete').style.display = 'none';
    }
    document.getElementById('modal-card').classList.add('active');
};

window.saveCardEdit = () => {
    const deck = appData.decks.find(d => d.id === currentDeckId);
    const did = document.getElementById('edit-display-id').value;
    const q = document.getElementById('edit-q').value;
    const a = document.getElementById('edit-a').value;
    const e = document.getElementById('edit-e').value;
    if (!q || !a) return alert("問題と答えは必須です");
    if (editingCardId) {
        const idx = deck.cards.findIndex(c => c.id === editingCardId);
        if (idx > -1) {
            deck.cards[idx].displayId = did; deck.cards[idx].question = q; deck.cards[idx].answer = a; deck.cards[idx].explanation = e;
        }
    } else {
        deck.cards.push({ id: 'c_' + Date.now(), displayId: did, question: q, answer: a, explanation: e, dueDate: 0, interval: 0, reps: 0, ef: 2.5 });
    }
    saveDeckToCloud(deck); window.closeModals(); renderManagerList();
};

window.deleteCard = () => {
    if (!confirm("削除しますか？")) return;
    const deck = appData.decks.find(d => d.id === currentDeckId);
    deck.cards = deck.cards.filter(c => c.id !== editingCardId);
    saveDeckToCloud(deck); window.closeModals(); renderManagerList();
};

// --- エクスポート機能 (CSV/TSV, 進捗あり/なし) ---
window.exportDeckData = (format, withProgress) => {
    const deck = appData.decks.find(d => d.id === currentDeckId);
    if (!deck) return;

    let content = "";
    const delimiter = format === 'csv' ? ',' : '\t';
    
    // ヘッダー行
    const headers = ["ID", "Question", "Answer", "Explanation"];
    if (withProgress) {
        headers.push("DueDate", "Interval", "Reps", "EF");
    }
    content += headers.map(h => escapeCell(h, delimiter)).join(delimiter) + "\n";

    // データ行
    deck.cards.forEach(c => {
        const row = [
            c.displayId || "",
            c.question || "",
            c.answer || "",
            c.explanation || ""
        ];
        
        if (withProgress) {
            // 日付を ISO String にする (Excelでそのまま読める形式)
            const dateStr = c.dueDate ? new Date(c.dueDate).toISOString() : "";
            row.push(dateStr);
            row.push(c.interval);
            row.push(c.reps);
            row.push(c.ef);
        }

        content += row.map(val => escapeCell(val, delimiter)).join(delimiter) + "\n";
    });

    // ファイルダウンロード
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]); // BOM
    const blob = new Blob([bom, content], { type: format === 'csv' ? "text/csv" : "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${deck.name}_${withProgress ? 'full' : 'cards'}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
};

// セルのエスケープ処理
function escapeCell(text, delimiter) {
    if (text === null || text === undefined) text = "";
    text = String(text);
    // 改行、区切り文字、ダブルクォートがあれば全体を囲む
    if (text.includes('\n') || text.includes('\r') || text.includes(delimiter) || text.includes('"')) {
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
}

// --- インポート機能 (ファイル or テキスト貼り付け) ---
window.executeImport = async () => {
    const fileInput = document.getElementById('fileInput');
    const textArea = document.getElementById('import-text-area');
    
    let content = "";

    // ファイルが選択されていればファイルを優先
    if (fileInput.files && fileInput.files[0]) {
        const file = fileInput.files[0];
        try {
            content = await readFileAsync(file);
        } catch(e) {
            alert("ファイル読み込みエラー: " + e);
            return;
        }
    } else {
        // ファイルがなければテキストエリアを使用
        content = textArea.value;
    }

    if (!content.trim()) {
        alert("インポートするデータがありません");
        return;
    }

    processImportContent(content);
};

function readFileAsync(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = e => reject(e);
        reader.readAsText(file);
    });
}

function processImportContent(content) {
    const deck = appData.decks.find(d => d.id === currentDeckId);
    if (!deck) return;

    // 区切り文字の自動判定
    const firstLineEnd = content.indexOf('\n');
    const firstLine = firstLineEnd > -1 ? content.substring(0, firstLineEnd) : content;
    const delimiter = firstLine.includes('\t') ? '\t' : ',';

    try {
        const rows = parseCSV(content, delimiter);
        let addedCount = 0;
        
        rows.forEach((row, i) => {
            if (row.length === 0 || (row.length === 1 && !row[0].trim())) return;
            // ヘッダー行スキップ (簡易判定)
            if (i === 0 && (row[0] === 'ID' || row[1] === 'Question')) return;

            // 最低限 QとA
            const did = row[0] || "";
            const q = row[1] || "";
            const a = row[2] || "";
            const exp = row[3] || "";
            
            if (!q || !a) return; 

            // 進捗データ読み込み
            let dueDate = 0;
            let interval = 0;
            let reps = 0;
            let ef = 2.5;

            if (row.length >= 8) {
                if (row[4]) dueDate = new Date(row[4]).getTime();
                if (row[5]) interval = parseFloat(row[5]);
                if (row[6]) reps = parseInt(row[6]);
                if (row[7]) ef = parseFloat(row[7]);
                
                if (isNaN(dueDate)) dueDate = 0;
                if (isNaN(interval)) interval = 0;
                if (isNaN(reps)) reps = 0;
                if (isNaN(ef)) ef = 2.5;
            }

            deck.cards.push({
                id: 'imp_' + Date.now() + '_' + i,
                displayId: did,
                question: q,
                answer: a,
                explanation: exp,
                dueDate: dueDate,
                interval: interval,
                reps: reps,
                ef: ef
            });
            addedCount++;
        });

        saveDeckToCloud(deck);
        window.closeModals();
        renderManagerList();
        alert(`${addedCount}件 インポートしました！`);
        refreshQueue(); 

    } catch (err) {
        console.error(err);
        alert("インポートエラー。フォーマットを確認してください。");
    }
}

function parseCSV(text, delimiter) {
    const rows = [];
    let currentRow = [];
    let currentCell = "";
    let insideQuote = false;
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (insideQuote) {
            if (char === '"') {
                if (nextChar === '"') {
                    currentCell += '"';
                    i++; 
                } else {
                    insideQuote = false;
                }
            } else {
                currentCell += char;
            }
        } else {
            if (char === '"') {
                insideQuote = true;
            } else if (char === delimiter) {
                currentRow.push(currentCell);
                currentCell = "";
            } else if (char === '\n' || char === '\r') {
                if (char === '\r' && nextChar === '\n') {
                    i++;
                }
                currentRow.push(currentCell);
                rows.push(currentRow);
                currentRow = [];
                currentCell = "";
            } else {
                currentCell += char;
            }
        }
    }
    if (currentCell || currentRow.length > 0) {
        currentRow.push(currentCell);
        rows.push(currentRow);
    }
    return rows;
}


window.exportAllData = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appData));
    const a = document.createElement('a');
    a.href = dataStr; a.download = "backup_" + new Date().toISOString().slice(0,10) + ".json";
    a.click();
};

window.restoreData = (input) => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.decks) {
                if (confirm("上書き復元しますか？現在のデータは消去され、バックアップデータで上書きされます。")) {
                    for(const d of appData.decks) { await deleteDeckFromCloud(d.id); }
                    appData = data; 
                    for(const d of appData.decks) { await saveDeckToCloud(d); }
                    alert("復元完了"); renderSettingsDeckList(); 
                }
            }
        } catch (err) { alert("読込失敗"); console.error(err); }
    };
    reader.readAsText(file); input.value = '';
};

window.renameDeck = (id) => {
    const deck = appData.decks.find(d => d.id === id);
    const name = prompt("新しい名前:", deck.name);
    if(name && name!==deck.name) { deck.name=name; saveDeckToCloud(deck); renderSettingsDeckList(); }
};

window.deleteDeck = (id) => {
    if(confirm("削除しますか？")) { 
        appData.decks = appData.decks.filter(d => d.id !== id); 
        deleteDeckFromCloud(id); 
        renderSettingsDeckList(); 
    }
};

function switchView(viewId) {
    ['deck-list-view', 'study-view', 'manager-view', 'settings-view', 'stats-view'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === viewId) ? 'flex' : 'none';
    });
    if(viewId === 'study-view') updateUndoButton();
}

function renderDeckList() {
    appData.decks.sort((a,b) => (a.order||0) - (b.order||0));
    const grid = document.getElementById('deck-grid');
    grid.innerHTML = '';
    const now = Date.now();
    appData.decks.forEach(deck => {
        const dueCount = deck.cards.filter(c => c.dueDate <= now).length;
        const el = document.createElement('div');
        el.className = 'deck-card';
        el.onclick = () => window.openStudy(deck.id);
        el.innerHTML = `
            <div class="deck-info">
                <div class="deck-title">${deck.name}</div>
                <div class="deck-stats">
                    <span class="stat-badge ${dueCount > 0 ? 'due' : ''}">学習待ち: ${dueCount}</span>
                    <span class="stat-badge">合計: ${deck.cards.length}</span>
                </div>
            </div>
        `;
        grid.appendChild(el);
    });

    let earliestDue = Infinity;
    let totalDue = 0;
    appData.decks.forEach(deck => {
        deck.cards.forEach(card => {
            if (card.dueDate <= now) totalDue++;
            else if (card.dueDate < earliestDue) earliestDue = card.dueDate;
        });
    });

    const infoEl = document.getElementById('next-study-text');
    if (totalDue > 0) {
        infoEl.innerText = totalDue + '件のカードが学習待ちです';
    } else if (earliestDue === Infinity) {
        infoEl.innerText = 'カードがありません';
    } else {
        const d = new Date(earliestDue);
        const diffMs = earliestDue - now;
        const diffMin = Math.floor(diffMs / 60000);
        const diffHour = Math.floor(diffMs / 3600000);
        const diffDay = Math.floor(diffMs / 86400000);
        let relativeText;
        if (diffMin < 1) relativeText = 'まもなく';
        else if (diffMin < 60) relativeText = diffMin + '分後';
        else if (diffHour < 24) relativeText = diffHour + '時間後';
        else relativeText = diffDay + '日後';
        const timeStr = (d.getMonth()+1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
        infoEl.innerText = timeStr + '（' + relativeText + '）';
    }
}

function renderSettingsDeckList() {
    appData.decks.sort((a,b) => (a.order||0) - (b.order||0));
    const list = document.getElementById('settings-deck-list');
    list.innerHTML = '';
    if (appData.decks.length === 0) {
        list.innerHTML = '<li style="padding:20px; text-align:center; color:var(--text-sub);">デッキがありません</li>';
        return;
    }
    appData.decks.forEach((deck, index) => {
        const isFirst = index === 0;
        const isLast = index === appData.decks.length - 1;
        const li = document.createElement('li');
        li.innerHTML = `
            <div class="deck-name-row">
                <span>${deck.name}</span>
                <span class="deck-count-badge">${deck.cards.length}</span>
            </div>
            <div class="deck-actions-row" style="display:flex; gap:4px;">
                <button class="action-icon-btn" onclick="moveDeck('${deck.id}', -1)" ${isFirst ? 'disabled style="opacity:0.3"' : ''}>⬆</button>
                <button class="action-icon-btn" onclick="moveDeck('${deck.id}', 1)" ${isLast ? 'disabled style="opacity:0.3"' : ''}>⬇</button>
                <div style="width:10px;"></div>
                <button class="action-icon-btn" title="名前変更" onclick="renameDeck('${deck.id}')">✏️</button>
                <button class="action-icon-btn danger" title="削除" onclick="deleteDeck('${deck.id}')">🗑️</button>
            </div>
        `;
        list.appendChild(li);
    });
}

window.moveDeck = async (id, dir) => {
    const idx = appData.decks.findIndex(d => d.id === id);
    if (idx === -1) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= appData.decks.length) return;
    const current = appData.decks[idx];
    const target = appData.decks[targetIdx];
    const tempOrder = current.order;
    current.order = target.order;
    target.order = tempOrder;
    appData.decks[idx] = target;
    appData.decks[targetIdx] = current;
    renderSettingsDeckList();
    await Promise.all([saveDeckToCloud(current), saveDeckToCloud(target)]);
};

function renderManagerList() {
    const list = document.getElementById('manager-list');
    list.innerHTML = '';
    const deck = appData.decks.find(d => d.id === currentDeckId);
    if (!deck) return;
    const term = document.getElementById('search-input').value.toLowerCase();
    const btnBulk = document.getElementById('btn-bulk-delete');
    btnBulk.style.display = 'none'; 
    [...deck.cards].reverse().forEach(card => {
        if (term && !card.question.toLowerCase().includes(term)) return;
        const li = document.createElement('li');
        li.className = 'manager-item';
        const numLabel = card.displayId ? `[${card.displayId}] ` : "";
        li.innerHTML = `
            <input type="checkbox" class="card-chk" value="${card.id}" onchange="toggleBulkButton()" style="margin-right:10px; transform:scale(1.2);">
            <div class="item-text" onclick="openEditModal('${card.id}')">${numLabel}${card.question}</div>
            <div class="item-actions">
                <button class="secondary-btn" style="margin:0; padding:5px 10px;" onclick="openEditModal('${card.id}')">編集</button>
            </div>
        `;
        list.appendChild(li);
    });
}

window.toggleBulkButton = () => {
    const anyChecked = document.querySelectorAll('.card-chk:checked').length > 0;
    document.getElementById('btn-bulk-delete').style.display = anyChecked ? 'block' : 'none';
};

window.deleteSelectedCards = () => {
    const checked = document.querySelectorAll('.card-chk:checked');
    if(checked.length === 0) return;
    if(!confirm(`${checked.length}枚のカードを削除しますか？`)) return;
    const ids = Array.from(checked).map(c => c.value);
    const deck = appData.decks.find(d => d.id === currentDeckId);
    deck.cards = deck.cards.filter(c => !ids.includes(c.id));
    saveDeckToCloud(deck); renderManagerList();
};

function refreshQueue() {
    const deck = appData.decks.find(d => d.id === currentDeckId);
    if (!deck) return;
    const now = Date.now();
    if (isCramMode) {
        studyQueue = deck.cards.filter(c => c.dueDate > now && !sessionReviewedIds.has(c.id)).sort((a,b) => a.dueDate - b.dueDate);
    } else {
        studyQueue = deck.cards.filter(c => c.dueDate <= now).sort((a,b) => a.dueDate - b.dueDate);
    }
    const total = window.sessionTotal || 1; 
    const studied = sessionReviewedIds.size;
    const currentTotal = studied + studyQueue.length;
    const pct = currentTotal > 0 ? (studied / currentTotal) * 100 : 100;
    document.getElementById('study-progress').style.width = pct + '%';

    if (studyQueue.length === 0) {
        document.getElementById('card-scene').classList.add('hidden');
        document.getElementById('controls').classList.remove('visible');
        document.getElementById('empty-state').classList.remove('hidden');
        const hasFuture = deck.cards.some(c => c.dueDate > now);
        if(isCramMode) {
                document.querySelector('#empty-state h2').innerText = "👏 学習完了！";
                document.querySelector('#empty-state .primary-btn').style.display = 'none';
        } else {
                document.querySelector('#empty-state h2').innerText = "🎉 コンプリート！";
                document.querySelector('#empty-state .primary-btn').style.display = hasFuture ? 'block' : 'none';
        }
    } else {
        document.getElementById('card-scene').classList.remove('hidden');
        document.getElementById('empty-state').classList.add('hidden');
        currentCard = studyQueue[0];
        renderCard();
    }
}

function renderCard() {
    const cardObj = document.getElementById('card-obj');
    document.querySelectorAll('.rate-btn').forEach(btn => btn.disabled = false);
    document.getElementById('controls').classList.remove('visible');
    cardObj.classList.remove('is-flipped');
    setTimeout(() => {
        const numText = currentCard.displayId ? `No. ${currentCard.displayId}` : "";
        document.getElementById('q-num').innerText = numText;
        document.getElementById('a-num').innerText = numText;
        document.getElementById('q-text').innerText = currentCard.question;
        document.getElementById('a-text').innerText = currentCard.answer;
        document.getElementById('exp-text').innerText = currentCard.explanation || "";
    }, 200);
}

document.getElementById('card-scene').addEventListener('click', () => {
    const cardObj = document.getElementById('card-obj');
    if (!currentCard) return;
    const controls = document.getElementById('controls');
    if (!controls.classList.contains('visible')) {
        controls.classList.add('visible');
        updateButtonLabels();
    }
    cardObj.classList.toggle('is-flipped');
});

function calculateNextState(card, rating) {
    let { interval, reps, ef } = card;
    let nextInterval, nextReps, nextEf;
    let drift = 0;
    if (rating === 1) drift = -0.2;
    else if (rating === 2) drift = -0.15;
    else if (rating === 4) drift = 0.15;
    nextEf = Math.max(1.3, ef + drift);
    const isRookie = reps === 0;
    if (rating === 1) {
        nextReps = 0;
        nextInterval = 0; 
    } else if (isRookie) {
        if (rating === 2) { nextInterval = 1; nextReps = 1; }
        else if (rating === 3) { nextInterval = 2; nextReps = 1; }
        else if (rating === 4) { nextInterval = 4; nextReps = 1; }
    } else {
        const base = Math.max(interval, 1);
        if (rating === 2) { nextInterval = base * 1.2; }
        else if (rating === 3) { nextInterval = base * nextEf; }
        else if (rating === 4) { nextInterval = base * nextEf * 1.3; }
        if (rating === 3) {
            const hardInterval = base * 1.2;
            if (nextInterval <= hardInterval) nextInterval = hardInterval + 1;
        }
        if (rating === 4) {
            let goodInterval = base * nextEf;
            const hardInterval = base * 1.2;
            if (goodInterval <= hardInterval) goodInterval = hardInterval + 1;
            if (nextInterval <= goodInterval) nextInterval = goodInterval + 1;
        }
        nextReps = reps + 1;
    }
    if (nextInterval > 3) {
        const fuzz = 0.95 + Math.random() * 0.1;
        nextInterval = nextInterval * fuzz;
    }
    const now = Date.now();
    let dueDate;
    if (nextInterval === 0) { dueDate = now + 10 * 60 * 1000; }
    else { dueDate = now + (nextInterval * 24 * 60 * 60 * 1000); }
    return { interval: nextInterval, reps: nextReps, ef: nextEf, dueDate };
}

function updateButtonLabels() {
    if (!currentCard) return;
    [1,2,3,4].forEach((r, i) => {
        const res = calculateNextState(currentCard, r);
        const ids = ['lbl-again', 'lbl-hard', 'lbl-good', 'lbl-easy'];
        let txt;
        if (res.interval === 0) txt = "10m";
        else if (res.interval < 1) {
            const mins = Math.round(res.interval * 1440);
            if (mins < 60) txt = mins + "m";
            else txt = Math.round(mins/60) + "h";
        }
        else {
            const days = Math.round(res.interval);
            if (days > 365) txt = (days/365).toFixed(1) + "y";
            else if (days > 30) txt = (days/30).toFixed(1) + "mo";
            else txt = days + "d";
        }
        document.getElementById(ids[i]).innerText = txt;
    });
}

// --- 統計保存ロジック ---
async function saveStudyLog(count, seconds) {
    if (!currentUser) return;
    const today = new Date().toLocaleDateString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit' }).replaceAll('/', '-');
    const logRef = doc(db, "users", currentUser.uid, "logs", today);
    const snap = await getDoc(logRef);
    if (snap.exists()) {
        const data = snap.data();
        await setDoc(logRef, { count: (data.count || 0) + count, seconds: (data.seconds || 0) + seconds });
    } else {
        await setDoc(logRef, { count, seconds });
    }
}

// --- 統計表示ロジック ---
window.openStats = async () => {
    switchView('stats-view');
    showLoading(true);
    if (!currentUser) {
        showLoading(false);
        return;
    }
    
    try {
        const todayStr = new Date().toLocaleDateString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit' }).replaceAll('/', '-');
        const logCol = collection(db, "users", currentUser.uid, "logs");
        const snp = await getDocs(logCol);
        const logs = snp.docs.map(d => ({ date: d.id, ...d.data() }));
        logs.sort((a, b) => b.date.localeCompare(a.date));
        
        const todayStatsEl = document.getElementById('today-stats');
        const todayLog = logs.find(l => l.date === todayStr);
        
        if (todayLog) {
            const min = Math.floor(todayLog.seconds / 60);
            todayStatsEl.innerHTML = `
                <span class="next-study-icon">✨</span>
                <div>
                    <div class="next-study-label">今日の結果</div>
                    <div class="next-study-value">${todayLog.count} 枚 / ${min} 分</div>
                </div>
            `;
        } else {
            todayStatsEl.innerHTML = `
                <span class="next-study-icon">📔</span>
                <div>
                    <div class="next-study-label">今日の結果</div>
                    <div class="next-study-value">今日の記録はまだありません</div>
                </div>
            `;
        }

        const listEl = document.getElementById('stats-log-list');
        listEl.innerHTML = '';
        if (logs.length === 0) {
            listEl.innerHTML = '<li style="padding:20px; text-align:center; color:var(--text-sub);">記録がまだありません</li>';
        } else {
            logs.forEach(log => {
                const min = Math.floor(log.seconds / 60);
                const li = document.createElement('li');
                li.style.flexDirection = 'column';
                li.style.alignItems = 'flex-start';
                li.style.gap = '8px';
                li.innerHTML = `
                    <div class="deck-name-row">
                        <span>${log.date}</span>
                    </div>
                    <div class="deck-stats">
                        <span class="stat-badge">${log.count} 枚</span>
                        <span class="stat-badge">${min} 分</span>
                    </div>
                `;
                listEl.appendChild(li);
            });
        }
    } catch(e) { 
        console.error("統計の取得に失敗しました:", e); 
    }
    showLoading(false);
};

document.addEventListener('keydown', (e) => {
    if (document.getElementById('study-view').style.display === 'flex') {
        const cardObj = document.getElementById('card-obj');
        const isFlipped = cardObj.classList.contains('is-flipped');
        if (e.code === 'Space' || e.key === 'Enter') {
            e.preventDefault();
            if (!currentCard) return;
            const controls = document.getElementById('controls');
            if (!controls.classList.contains('visible')) {
                controls.classList.add('visible');
                updateButtonLabels();
            }
            cardObj.classList.toggle('is-flipped');
        } else if (isFlipped) {
            if (e.key === '1') rateCard(1);
            if (e.key === '2') rateCard(2);
            if (e.key === '3') rateCard(3);
            if (e.key === '4') rateCard(4);
        }
        if (e.key === 'z' || e.key === 'Z') {
            if (!document.getElementById('btnUndo').disabled) handleUndo();
        }
    }
});

function showLoading(show) { document.getElementById('loading').style.display = show ? 'flex' : 'none'; }

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker registered!', reg))
            .catch(err => console.log('Service Worker registration failed:', err));
    });
}
