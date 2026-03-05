import { createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
// 👇 追加: query, where, getCountFromServer, writeBatch, orderBy, limit などを読み込む
import { doc, getDoc, setDoc, collection, getDocs, deleteDoc, query, where, getCountFromServer, writeBatch, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getToken, deleteToken } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging.js";
import { auth, db, messaging } from "./firebase-init.js";

let appData = { decks: [] }; // デッキの基本情報（名前、ステータス等）だけを保持
let currentDeckCards = [];   // 学習や管理画面を開いた時だけ、そのデッキのカード一覧をここに読み込む

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
const VAPID_KEY = 'BNMUf79US783cO3ERIR9skf7p0XS81XIRx6eWuwWVSRIG5FuvAdntJYr6SgpAc3HNloSvADLBqhPf9oyoOVFsuA';

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), ms));

onAuthStateChanged(auth, async (user) => {
    const authView = document.getElementById('auth-view');
    if (user) {
        currentUser = user;
        document.getElementById('user-email-display').innerText = user.email;
        authView.style.display = 'none';
        
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

        showLoading(false);
        switchView('deck-list-view');
        renderDeckList();

        if (localStorage.getItem('notify_on_' + currentUser.uid) === '1') {
            saveDeviceToken();
        }

        const urlParams = new URLSearchParams(window.location.search);
        const targetDeckId = urlParams.get('openDeck');
        if (targetDeckId) {
            setTimeout(() => {
                window.openStudy(targetDeckId);
                window.history.replaceState({}, document.title, window.location.pathname);
            }, 500);
        }

    } else {
        currentUser = null;
        document.querySelectorAll('.container').forEach(el => el.style.display = 'none');
        showLoading(false);
        authView.style.display = 'flex';
    }
});

async function saveDeviceToken() {
    if (!currentUser) return;
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            localStorage.setItem('notify_on_' + currentUser.uid, '1');
            
            let registration;
            if ('serviceWorker' in navigator) {
                registration = await navigator.serviceWorker.register('./sw.js');
                await navigator.serviceWorker.ready;
            }

            const currentToken = await getToken(messaging, {
                vapidKey: VAPID_KEY,
                serviceWorkerRegistration: registration
            });

            if (currentToken) {
                console.log('デバイストークンを取得:', currentToken);
                const tokenRef = doc(db, "users", currentUser.uid, "tokens", currentToken);
                await setDoc(tokenRef, {
                    token: currentToken,
                    updatedAt: Date.now()
                });
            }
        } else {
            console.log('通知が許可されませんでした');
        }
    } catch (error) {
        console.error('トークン取得エラー:', error);
    }
}

window.disableNotifications = async () => {
    if (!currentUser) return;
    try {
        localStorage.removeItem('notify_on_' + currentUser.uid);
        
        let registration;
        if ('serviceWorker' in navigator) {
            registration = await navigator.serviceWorker.getRegistration('./sw.js');
        }

        if (registration) {
            const currentToken = await getToken(messaging, {
                vapidKey: VAPID_KEY,
                serviceWorkerRegistration: registration
            });
            if (currentToken) {
                const tokenRef = doc(db, "users", currentUser.uid, "tokens", currentToken);
                await deleteDoc(tokenRef);
                await deleteToken(messaging);
                console.log('通知トークンを削除しました。');
            }
        }
    } catch (e) {
        console.error('通知の無効化に失敗しました:', e);
    }
};

window.toggleNotificationSetting = async () => {
    const toggle = document.getElementById('notification-toggle');
    if (!currentUser) return;

    if (toggle.checked) {
        await saveNotificationSettings(); 
        await saveDeviceToken();
    } else {
        await disableNotifications();
    }
    await updateNotificationStatusDisplay();
};

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

// --- サブコレクション仕様のデータ読み込み ---
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
                if (!d.status) { d.status = 'active'; changed = true; }
            });
            if (changed) { appData.decks.forEach(d => saveDeckToCloud(d)); }
        } else {
            initDefaultData();
        }
    } catch (error) { console.error(error); alert("読込失敗"); }
}

async function saveDeckToCloud(deck) {
    if (!currentUser || !deck) return;
    try {
        const payload = { id: deck.id, name: deck.name, order: deck.order, status: deck.status };
        await setDoc(doc(db, "users", currentUser.uid, "decks", deck.id), payload, { merge: true });
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
    currentDeckCards = [];
}

window.openSettings = async () => { 
    switchView('settings-view'); 
    renderSettingsDeckList(); 
    const meta = document.querySelector('meta[name="data-app-version"]');
    if (meta) {
        document.getElementById('app-version').innerText = meta.content;
    }
    await updateNotificationStatusDisplay();
};

async function updateNotificationStatusDisplay() {
    const statusDisplay = document.getElementById('notification-status-display');
    const btnRequest = document.getElementById('btn-request-notification');
    const toggleContainer = document.getElementById('notification-toggle-container');
    const toggleCheckbox = document.getElementById('notification-toggle');
    const detailsContainer = document.getElementById('notification-details-container');
    
    if (!('Notification' in window)) {
        statusDisplay.innerText = "このブラウザはプッシュ通知をサポートしていません。";
        statusDisplay.className = "user-email-display text-sub";
        statusDisplay.style.display = 'block';
        btnRequest.style.display = 'none';
        toggleContainer.style.display = 'none';
        detailsContainer.style.display = 'none';
        return;
    }

    switch (Notification.permission) {
        case 'granted':
            statusDisplay.style.display = 'none';
            btnRequest.style.display = 'none';
            toggleContainer.style.display = 'flex';
            toggleCheckbox.checked = (currentUser && localStorage.getItem('notify_on_' + currentUser.uid) === '1');
            
            if (toggleCheckbox.checked && currentUser) {
                detailsContainer.style.display = 'flex';
                const settingsRef = doc(db, "users", currentUser.uid, "settings", "notification");
                const snap = await getDoc(settingsRef);
                if (snap.exists()) {
                    const data = snap.data();
                    document.getElementById('notify-interval-hours').value = data.intervalHours || 1;
                    document.getElementById('notify-start-hour').value = data.startHour || 7;
                    document.getElementById('notify-end-hour').value = data.endHour || 23;
                }
            } else {
                detailsContainer.style.display = 'none';
            }
            break;
            
        case 'denied':
            statusDisplay.innerText = "通知は『ブロック』されています ❌\n(ブラウザの設定から解除してください)";
            statusDisplay.className = "user-email-display text-danger";
            statusDisplay.style.display = 'block';
            btnRequest.style.display = 'none';
            toggleContainer.style.display = 'none';
            detailsContainer.style.display = 'none';
            break;
            
        default:
            statusDisplay.innerText = "通知を受信するには許可が必要です。";
            statusDisplay.className = "user-email-display text-sub";
            statusDisplay.style.display = 'block';
            btnRequest.style.display = 'block';
            toggleContainer.style.display = 'none';
            detailsContainer.style.display = 'none';
            break;
    }
}

window.requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
         alert("このブラウザはプッシュ通知をサポートしていません。");
         return;
    }
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
             await saveDeviceToken();
             alert("通知を許可しました！");
        }
        updateNotificationStatusDisplay();
    } catch (e) {
        console.error("通知の許可リクエスト中にエラーが発生しました:", e);
        alert("エラーが発生しました。");
    }
};

window.backToDecks = async () => { 
    if (sessionStartTime && sessionCardsCount > 0) {
        const duration = Math.floor((Date.now() - sessionStartTime) / 1000); 
        await saveStudyLog(sessionCardsCount, duration);
    }
    sessionStartTime = null;
    sessionCardsCount = 0;
    currentDeckCards = []; // メモリ解放
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
        const newDeck = { id:'d_'+Date.now(), name, order: maxOrder + 1, status: 'active' };
        appData.decks.push(newDeck);
        saveDeckToCloud(newDeck); 
        renderDeckList(); 
        window.closeModals();
        document.getElementById('new-deck-name').value = '';
    }
};

// --- 学習画面を開く時に「初めて」カード一覧をダウンロードする ---
window.openStudy = async (id) => {
    currentDeckId = id; isCramMode = false; sessionReviewedIds.clear(); historyStack = [];
    sessionStartTime = Date.now(); 
    sessionCardsCount = 0;         
    const deck = appData.decks.find(d => d.id === id);
    if(!deck) return;
    document.getElementById('study-title').innerText = deck.name;
    
    showLoading(true);
    try {
        const cardsCol = collection(db, "users", currentUser.uid, "decks", id, "cards");
        const snap = await getDocs(cardsCol);
        currentDeckCards = snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));

        window.sessionTotal = currentDeckCards.filter(c => c.dueDate <= Date.now()).length; 
        if(window.sessionTotal === 0 && currentDeckCards.length > 0) window.sessionTotal = currentDeckCards.length; 
        
        switchView('study-view'); 
        refreshQueue();
    } catch(e) {
        console.error(e);
        alert("カードの読み込みに失敗しました");
    } finally {
        showLoading(false);
    }
};

window.openManager = () => { switchView('manager-view'); renderManagerList(); };
window.closeManager = () => { switchView('study-view'); refreshQueue(); };

window.showDeckMenu = () => {
    document.getElementById('modal-deck-menu').classList.add('active');
    document.getElementById('import-text-area').value = '';
    document.getElementById('fileInput').value = '';
};

window.startCramMode = () => { 
    isCramMode = true; sessionReviewedIds.clear(); historyStack = []; 
    window.sessionTotal = currentDeckCards.length;
    refreshQueue(); 
};

window.rateCard = async (rating) => {
    if (!currentCard) return;
    sessionCardsCount++; 
    document.querySelectorAll('.rate-btn').forEach(btn => btn.disabled = true);
    
    const cardStateCopy = JSON.parse(JSON.stringify(currentCard));
    historyStack.push({ card: cardStateCopy, isCramMode: isCramMode });
    updateUndoButton();
    sessionReviewedIds.add(currentCard.id);
    
    const next = calculateNextState(currentCard, rating);
    const updatedCard = { ...currentCard, ...next };

    const idx = currentDeckCards.findIndex(c => c.id === currentCard.id);
    if (idx !== -1) currentDeckCards[idx] = updatedCard;

    try {
        const cardRef = doc(db, "users", currentUser.uid, "decks", currentDeckId, "cards", currentCard.id);
        await setDoc(cardRef, updatedCard, { merge: true });
    } catch(e) {
        console.error("保存エラー:", e);
    }

    refreshQueue();
};

window.handleUndo = async () => {
    if (historyStack.length === 0) return;
    const prevState = historyStack.pop();
    const prevCard = prevState.card;

    const idx = currentDeckCards.findIndex(c => c.id === prevCard.id);
    if (idx !== -1) currentDeckCards[idx] = prevCard;

    sessionReviewedIds.delete(prevCard.id);
    if (sessionCardsCount > 0) sessionCardsCount--; 

    try {
        const cardRef = doc(db, "users", currentUser.uid, "decks", currentDeckId, "cards", prevCard.id);
        await setDoc(cardRef, prevCard, { merge: true });
    } catch(e) {
        console.error("Undoエラー:", e);
    }

    refreshQueue(); updateUndoButton();
};

function updateUndoButton() {
    const btn = document.getElementById('btnUndo');
    btn.disabled = (historyStack.length === 0);
    btn.style.opacity = (historyStack.length === 0) ? '0.3' : '1';
}

window.renderManagerList = renderManagerList;

window.openEditModal = (cardId) => {
    editingCardId = cardId;
    if (cardId) {
        const card = currentDeckCards.find(c => c.id === cardId);
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

window.saveCardEdit = async () => {
    const did = document.getElementById('edit-display-id').value;
    const q = document.getElementById('edit-q').value;
    const a = document.getElementById('edit-a').value;
    const e = document.getElementById('edit-e').value;
    if (!q || !a) return alert("問題と答えは必須です");
    
    showLoading(true);
    try {
        const cardsCol = collection(db, "users", currentUser.uid, "decks", currentDeckId, "cards");
        if (editingCardId) {
            const idx = currentDeckCards.findIndex(c => c.id === editingCardId);
            if (idx > -1) {
                currentDeckCards[idx].displayId = did; 
                currentDeckCards[idx].question = q; 
                currentDeckCards[idx].answer = a; 
                currentDeckCards[idx].explanation = e;

                const cardRef = doc(cardsCol, editingCardId);
                await setDoc(cardRef, currentDeckCards[idx], { merge: true });
            }
        } else {
            const newCardRef = doc(cardsCol); 
            const newCard = {
                id: newCardRef.id,
                displayId: did, question: q, answer: a, explanation: e, 
                dueDate: 0, interval: 0, reps: 0, ef: 2.5
            };
            currentDeckCards.push(newCard);
            await setDoc(newCardRef, newCard);
        }
        window.closeModals(); renderManagerList();
    } catch(err) {
        console.error(err);
        alert("カードの保存に失敗しました");
    }
    showLoading(false);
};

window.deleteCard = async () => {
    if (!confirm("削除しますか？")) return;
    showLoading(true);
    try {
        await deleteDoc(doc(db, "users", currentUser.uid, "decks", currentDeckId, "cards", editingCardId));
        currentDeckCards = currentDeckCards.filter(c => c.id !== editingCardId);
        window.closeModals(); renderManagerList();
    } catch(e) {
        console.error(e);
        alert("削除に失敗しました");
    }
    showLoading(false);
};

window.exportDeckData = (format, withProgress) => {
    if (!currentDeckCards) return;

    let content = "";
    const delimiter = format === 'csv' ? ',' : '\t';
    
    const headers = ["ID", "Question", "Answer", "Explanation"];
    if (withProgress) {
        headers.push("DueDate", "Interval", "Reps", "EF");
    }
    content += headers.map(h => escapeCell(h, delimiter)).join(delimiter) + "\n";

    currentDeckCards.forEach(c => {
        const row = [
            c.displayId || "",
            c.question || "",
            c.answer || "",
            c.explanation || ""
        ];
        
        if (withProgress) {
            const dateStr = c.dueDate ? new Date(c.dueDate).toISOString() : "";
            row.push(dateStr);
            row.push(c.interval);
            row.push(c.reps);
            row.push(c.ef);
        }

        content += row.map(val => escapeCell(val, delimiter)).join(delimiter) + "\n";
    });

    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]); 
    const blob = new Blob([bom, content], { type: format === 'csv' ? "text/csv" : "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deck_${withProgress ? 'full' : 'cards'}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
};

function escapeCell(text, delimiter) {
    if (text === null || text === undefined) text = "";
    text = String(text);
    if (text.includes('\n') || text.includes('\r') || text.includes(delimiter) || text.includes('"')) {
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
}

window.executeImport = async () => {
    const fileInput = document.getElementById('fileInput');
    const textArea = document.getElementById('import-text-area');
    let content = "";

    if (fileInput.files && fileInput.files[0]) {
        const file = fileInput.files[0];
        try {
            content = await readFileAsync(file);
        } catch(e) {
            alert("ファイル読み込みエラー: " + e);
            return;
        }
    } else {
        content = textArea.value;
    }

    if (!content.trim()) {
        alert("インポートするデータがありません");
        return;
    }

    await processImportContent(content);
};

function readFileAsync(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = e => reject(e);
        reader.readAsText(file);
    });
}

// --- 最大500件ずつバッチ処理でインポート ---
async function processImportContent(content) {
    const firstLineEnd = content.indexOf('\n');
    const firstLine = firstLineEnd > -1 ? content.substring(0, firstLineEnd) : content;
    const delimiter = firstLine.includes('\t') ? '\t' : ',';

    showLoading(true);
    try {
        const rows = parseCSV(content, delimiter);
        let addedCount = 0;
        
        const cardsCol = collection(db, "users", currentUser.uid, "decks", currentDeckId, "cards");
        let batch = writeBatch(db);
        let operationCount = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.length === 0 || (row.length === 1 && !row[0].trim())) continue;
            if (i === 0 && (row[0] === 'ID' || row[1] === 'Question')) continue;

            const did = row[0] || "";
            const q = row[1] || "";
            const a = row[2] || "";
            const exp = row[3] || "";
            
            if (!q || !a) continue; 

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

            const newCardRef = doc(cardsCol);
            const newCard = {
                id: newCardRef.id, displayId: did, question: q, answer: a, explanation: exp,
                dueDate: dueDate, interval: interval, reps: reps, ef: ef
            };
            currentDeckCards.push(newCard);
            
            batch.set(newCardRef, newCard);
            addedCount++;
            operationCount++;

            if (operationCount === 490) {
                await batch.commit();
                batch = writeBatch(db);
                operationCount = 0;
            }
        }

        if (operationCount > 0) {
            await batch.commit();
        }

        window.closeModals();
        renderManagerList();
        alert(`${addedCount}件 インポートしました！`);
        refreshQueue(); 

    } catch (err) {
        console.error(err);
        alert("インポート中にエラーが発生しました。");
    }
    showLoading(false);
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

window.exportAllData = async () => {
    if (!currentUser) return;
    showLoading(true);
    try {
        const fullData = { decks: [] };
        for (const d of appData.decks) {
            const deckCopy = { ...d, cards: [] };
            const cardsCol = collection(db, "users", currentUser.uid, "decks", d.id, "cards");
            const snap = await getDocs(cardsCol);
            deckCopy.cards = snap.docs.map(doc => doc.data());
            fullData.decks.push(deckCopy);
        }

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(fullData));
        const a = document.createElement('a');
        a.href = dataStr; a.download = "backup_" + new Date().toISOString().slice(0,10) + ".json";
        a.click();
    } catch (e) {
        console.error(e);
        alert("バックアップ作成に失敗しました");
    }
    showLoading(false);
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
                    showLoading(true);
                    
                    // 現在のデータを全削除
                    for (const d of appData.decks) {
                        const cardsCol = collection(db, "users", currentUser.uid, "decks", d.id, "cards");
                        const snap = await getDocs(cardsCol);
                        const batch = writeBatch(db);
                        snap.docs.forEach(doc => batch.delete(doc.ref));
                        await batch.commit();
                        await deleteDeckFromCloud(d.id);
                    }

                    appData.decks = [];

                    // 新しいデータを挿入
                    for (const d of data.decks) {
                        const newDeck = { id: d.id, name: d.name, order: d.order, status: d.status || 'active' };
                        appData.decks.push(newDeck);
                        await saveDeckToCloud(newDeck);

                        if (d.cards && d.cards.length > 0) {
                            const cardsCol = collection(db, "users", currentUser.uid, "decks", d.id, "cards");
                            let batch = writeBatch(db);
                            let count = 0;
                            for (const c of d.cards) {
                                const cardId = c.id || doc(cardsCol).id;
                                c.id = cardId;
                                batch.set(doc(cardsCol, cardId), c);
                                count++;
                                if (count === 490) {
                                    await batch.commit();
                                    batch = writeBatch(db);
                                    count = 0;
                                }
                            }
                            if (count > 0) await batch.commit();
                        }
                    }
                    alert("復元完了"); renderSettingsDeckList(); renderDeckList();
                    showLoading(false);
                }
            }
        } catch (err) { alert("読込失敗"); console.error(err); showLoading(false); }
    };
    reader.readAsText(file); input.value = '';
};

window.renameDeck = (id) => {
    const deck = appData.decks.find(d => d.id === id);
    if (!deck) return;
    const name = prompt("新しい名前:", deck.name);
    if(name && name!==deck.name) { deck.name=name; saveDeckToCloud(deck); renderSettingsDeckList(); renderDeckList(); }
};

window.deleteDeck = async (id) => {
    if(confirm("削除しますか？")) { 
        showLoading(true);
        try {
            // まずサブコレクション（カード）を全て削除
            const cardsCol = collection(db, "users", currentUser.uid, "decks", id, "cards");
            const snap = await getDocs(cardsCol);
            const batch = writeBatch(db);
            snap.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();

            // その後、デッキ本体を削除
            await deleteDeckFromCloud(id); 

            appData.decks = appData.decks.filter(d => d.id !== id); 
            renderSettingsDeckList(); 
        } catch(e) {
            console.error(e);
            alert("デッキの削除に失敗しました");
        }
        showLoading(false);
    }
};

function switchView(viewId) {
    ['deck-list-view', 'study-view', 'manager-view', 'settings-view', 'stats-view'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === viewId) ? 'flex' : 'none';
    });
    if(viewId === 'study-view') updateUndoButton();
}

// --- カウント機能を使って通信量を節約して描画する ---
async function renderDeckList() {
    appData.decks.sort((a,b) => (a.order||0) - (b.order||0));
    const grid = document.getElementById('deck-grid');
    grid.innerHTML = '';
    const now = Date.now();

    if (appData.decks.length === 0) {
        const infoEl = document.getElementById('next-study-text');
        infoEl.innerText = 'デッキがありません';
        return;
    }

    // 初回は「計算中...」で枠だけ作る
    appData.decks.forEach(deck => {
        const el = document.createElement('div');
        el.className = 'deck-card' + (deck.status === 'standby' ? ' deck-standby' : '');
        el.onclick = () => window.openStudy(deck.id);
        
        let statsHtml = '';
        if (deck.status === 'standby') {
             statsHtml = `<span class="stat-badge standby">💤 スタンバイ</span>`;
        } else {
             statsHtml = `<span class="stat-badge" id="due-badge-${deck.id}">学習待ち: 計算中...</span>`;
        }
        
        el.innerHTML = `
            <div class="deck-info">
                <div class="deck-title">${deck.name}</div>
                <div class="deck-stats">
                    ${statsHtml}
                    <span class="stat-badge" id="total-badge-${deck.id}">合計: 計算中...</span>
                </div>
            </div>
        `;
        grid.appendChild(el);
    });

    let totalDueOverall = 0;
    let earliestDue = Infinity;

    // 非同期でカードの枚数だけを取得する
    for (const deck of appData.decks) {
        try {
            const cardsCol = collection(db, "users", currentUser.uid, "decks", deck.id, "cards");

            const totalSnap = await getCountFromServer(cardsCol);
            const totalCount = totalSnap.data().count;
            const totalBadge = document.getElementById(`total-badge-${deck.id}`);
            if (totalBadge) totalBadge.innerText = `合計: ${totalCount}`;

            if (deck.status !== 'standby') {
                const dueQuery = query(cardsCol, where("dueDate", "<=", now));
                const dueSnap = await getCountFromServer(dueQuery);
                const dueCount = dueSnap.data().count;

                const dueBadge = document.getElementById(`due-badge-${deck.id}`);
                if (dueBadge) {
                    dueBadge.innerText = `学習待ち: ${dueCount}`;
                    if (dueCount > 0) dueBadge.classList.add('due');
                    else dueBadge.classList.remove('due');
                }
                totalDueOverall += dueCount;

                // 学習待ちがない場合は、一番近い将来の復習日時を取得
                if (dueCount === 0) {
                    const nextQuery = query(cardsCol, where("dueDate", ">", now), orderBy("dueDate", "asc"), limit(1));
                    const nextSnap = await getDocs(nextQuery);
                    if (!nextSnap.empty) {
                        const nextDate = nextSnap.docs[0].data().dueDate;
                        if (nextDate < earliestDue) earliestDue = nextDate;
                    }
                }
            }
        } catch(e) {
            console.error("カウント取得エラー", e);
        }
    }

    const infoEl = document.getElementById('next-study-text');
    if (totalDueOverall > 0) {
        infoEl.innerText = totalDueOverall + '件のカードが学習待ちです';
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

async function renderSettingsDeckList() {
    appData.decks.sort((a,b) => (a.order||0) - (b.order||0));
    const list = document.getElementById('settings-deck-list');
    list.innerHTML = '';
    if (appData.decks.length === 0) {
        list.innerHTML = '<li style="padding:20px; text-align:center; color:var(--text-sub);">デッキがありません</li>';
        return;
    }
    
    for (const deck of appData.decks) {
        const index = appData.decks.indexOf(deck);
        const isFirst = index === 0;
        const isLast = index === appData.decks.length - 1;
        const li = document.createElement('li');
        const isStandby = deck.status === 'standby';
        li.style.flexDirection = 'column';
        li.style.alignItems = 'stretch';
        li.style.gap = '8px';
        li.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <label class="toggle-switch deck-toggle" title="学習中/スタンバイ切り替え">
                    <input type="checkbox" onchange="toggleDeckStatus('${deck.id}')" ${!isStandby ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
                <span style="flex:1; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${isStandby ? 'opacity:0.5; text-decoration:line-through; font-weight:normal;' : ''}">${deck.name}</span>
                <span class="deck-count-badge" id="settings-count-${deck.id}" style="flex-shrink:0;">...</span>
            </div>
            <div style="display:flex; justify-content:flex-end; gap:4px;">
                <button class="action-icon-btn" onclick="moveDeck('${deck.id}', -1)" ${isFirst ? 'disabled style="opacity:0.3"' : ''}>⬆</button>
                <button class="action-icon-btn" onclick="moveDeck('${deck.id}', 1)" ${isLast ? 'disabled style="opacity:0.3"' : ''}>⬇</button>
                <div style="width:10px;"></div>
                <button class="action-icon-btn" title="名前変更" onclick="renameDeck('${deck.id}')">✏️</button>
                <button class="action-icon-btn danger" title="削除" onclick="deleteDeck('${deck.id}')">🗑️</button>
            </div>
        `;
        list.appendChild(li);

        // 非同期で枚数を取得して表示
        getCountFromServer(collection(db, "users", currentUser.uid, "decks", deck.id, "cards"))
            .then(snap => {
                const badge = document.getElementById(`settings-count-${deck.id}`);
                if (badge) badge.innerText = snap.data().count;
            }).catch(e => console.error(e));
    }
}

window.toggleDeckStatus = async (id) => {
    const deck = appData.decks.find(d => d.id === id);
    if (!deck) return;
    deck.status = deck.status === 'standby' ? 'active' : 'standby';
    await saveDeckToCloud(deck);
    renderSettingsDeckList();
};

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
    const term = document.getElementById('search-input').value.toLowerCase();
    const btnBulk = document.getElementById('btn-bulk-delete');
    btnBulk.style.display = 'none'; 
    
    [...currentDeckCards].reverse().forEach(card => {
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

window.deleteSelectedCards = async () => {
    const checked = document.querySelectorAll('.card-chk:checked');
    if(checked.length === 0) return;
    if(!confirm(`${checked.length}枚のカードを削除しますか？`)) return;
    
    showLoading(true);
    try {
        const ids = Array.from(checked).map(c => c.value);
        const batch = writeBatch(db);

        ids.forEach(id => {
            const cardRef = doc(db, "users", currentUser.uid, "decks", currentDeckId, "cards", id);
            batch.delete(cardRef);
        });

        await batch.commit();

        currentDeckCards = currentDeckCards.filter(c => !ids.includes(c.id));
        renderManagerList();
    } catch(e) {
        console.error(e);
        alert("一括削除に失敗しました");
    }
    showLoading(false);
};

function refreshQueue() {
    const now = Date.now();
    if (isCramMode) {
        studyQueue = currentDeckCards.filter(c => c.dueDate > now && !sessionReviewedIds.has(c.id)).sort((a,b) => a.dueDate - b.dueDate);
    } else {
        studyQueue = currentDeckCards.filter(c => c.dueDate <= now).sort((a,b) => a.dueDate - b.dueDate);
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
        const hasFuture = currentDeckCards.some(c => c.dueDate > now);
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

window.saveNotificationSettings = async () => {
    if (!currentUser) return;
    
    const interval = document.getElementById('notify-interval-hours').value;
    const start = document.getElementById('notify-start-hour').value;
    const end = document.getElementById('notify-end-hour').value;

    try {
        const settingsRef = doc(db, "users", currentUser.uid, "settings", "notification");
        await setDoc(settingsRef, {
            intervalHours: Number(interval),
            startHour: Number(start),
            endHour: Number(end),
            updatedAt: Date.now()
        }, { merge: true }); 
        console.log("通知設定を保存しました:", { interval, start, end });
    } catch (e) {
        console.error("設定保存エラー:", e);
    }
};