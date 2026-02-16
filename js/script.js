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

const STORAGE_KEY = 'smart_srs_v3'; 

onAuthStateChanged(auth, async (user) => {
    const authView = document.getElementById('auth-view');
    if (user) {
        currentUser = user;
        document.getElementById('user-email-display').innerText = user.email;
        authView.style.display = 'none';
        showLoading(true);
        await loadDataFromCloud();
        showLoading(false);
        switchView('deck-list-view');
        renderDeckList();
    } else {
        currentUser = null;
        document.querySelectorAll('.container').forEach(el => el.style.display = 'none');
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
        // Replicate onAuthStateChanged flow
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
    // If bypass happened, currentUser might be set? 
    // But usually click fires after mouseup. If timer triggered, view changed?
    // If view changed, this click might not matter or might target hidden element.
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
            // Sort by order if available
            appData.decks.sort((a, b) => (a.order || 0) - (b.order || 0));
            // Assign order if missing
            let changed = false;
            appData.decks.forEach((d, i) => {
                if (d.order === undefined) { d.order = i; changed = true; }
            });
            if (changed) { appData.decks.forEach(d => saveDeckToCloud(d)); }
        } else {
            // Legacy check
            const userDocRef = doc(db, "users", currentUser.uid);
            const docSnap = await getDoc(userDocRef);
            if (docSnap.exists() && docSnap.data().appData) {
                appData = docSnap.data().appData;
                // Migrate
                // Add order
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

window.openSettings = () => { switchView('settings-view'); renderSettingsDeckList(); };
window.backToDecks = () => { switchView('deck-list-view'); renderDeckList(); sessionReviewedIds.clear(); historyStack = []; };
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

window.openStudy = (id) => {
    currentDeckId = id; isCramMode = false; sessionReviewedIds.clear(); historyStack = [];
    const deck = appData.decks.find(d => d.id === id);
    if(!deck) return;
    document.getElementById('study-title').innerText = deck.name;
    // Total cards for progress calculation
    window.sessionTotal = deck.cards.filter(c => c.dueDate <= Date.now()).length; 
    if(window.sessionTotal === 0 && deck.cards.length > 0) window.sessionTotal = deck.cards.length; // If cram mode or all done, just use total? Adjusted in refreshQueue
    switchView('study-view'); refreshQueue();
};

window.openManager = () => { switchView('manager-view'); renderManagerList(); };
window.closeManager = () => { switchView('study-view'); refreshQueue(); };
window.showDeckMenu = () => document.getElementById('modal-import').classList.add('active');
window.startCramMode = () => { 
    isCramMode = true; sessionReviewedIds.clear(); historyStack = []; 
    const deck = appData.decks.find(d => d.id === currentDeckId);
    window.sessionTotal = deck.cards.length;
    refreshQueue(); 
};

window.rateCard = (rating) => {
    if (!currentCard) return;
    // Disable buttons to prevent double submission
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
    if (idx !== -1) deck.cards[idx] = prevCard;
    if (prevState.isCramMode) sessionReviewedIds.delete(prevCard.id);
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

window.handleImport = () => {
    const file = document.getElementById('fileInput').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const content = e.target.result;
        const deck = appData.decks.find(d => d.id === currentDeckId);
        try {
            if (file.name.endsWith('.json')) { alert("設定画面の「復元」から行ってください"); return; }
            const lines = content.trim().split('\n');
            
            // Auto-detect delimiter
            const firstLine = lines.find(l => l.trim().length > 0) || lines[0];
            const delimiter = firstLine && firstLine.includes('\t') ? '\t' : ',';

            let added = 0;
            lines.forEach((l, i) => {
                const c = l.split(delimiter);
                if(c.length>=2) {
                    deck.cards.push({
                        id: 'imp_'+Date.now()+i, displayId: c[0] || "",
                        question: c[1], answer: c[2], explanation: c[3]||"",
                        dueDate: 0, interval: 0, reps: 0, ef: 2.5
                    });
                    added++;
                }
            });
            saveDeckToCloud(deck); window.closeModals(); renderManagerList();
            alert(`${added}件インポート完了`); refreshQueue();
        } catch(err) { alert("エラー: " + err); }
    };
    reader.readAsText(file);
};

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
                    // Delete all existing decks first
                    for(const d of appData.decks) { await deleteDeckFromCloud(d.id); }
                    appData = data; 
                    // Save all restored decks
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
    ['deck-list-view', 'study-view', 'manager-view', 'settings-view'].forEach(id => {
        document.getElementById(id).style.display = (id === viewId) ? 'flex' : 'none';
    });
    if(viewId === 'study-view') updateUndoButton();
}

function renderDeckList() {
    // Ensure sorted
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

    // Calculate next study time across all decks
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
    // Ensure sorted
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
    
    // Swap
    const current = appData.decks[idx];
    const target = appData.decks[targetIdx];
    
    // Swap orders. If order is same (shouldn't happen but safe), ensure distinct
    const tempOrder = current.order;
    current.order = target.order;
    target.order = tempOrder;
    
    // Local swap for immediate UI update
    appData.decks[idx] = target;
    appData.decks[targetIdx] = current;
    
    renderSettingsDeckList();
    
    // Save both
    await Promise.all([saveDeckToCloud(current), saveDeckToCloud(target)]);
};

function renderManagerList() {
    const list = document.getElementById('manager-list');
    list.innerHTML = '';
    const deck = appData.decks.find(d => d.id === currentDeckId);
    if (!deck) return;
    const term = document.getElementById('search-input').value.toLowerCase();
    
    // Show/Hide bulk delete button
    const btnBulk = document.getElementById('btn-bulk-delete');
    btnBulk.style.display = 'none'; // hidden initially or when list rerenders
    
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

    // Update Progress Bar
    const total = window.sessionTotal || 1; 
    const studied = sessionReviewedIds.size;
    // For standard mode, sessionTotal is typically fixed at start. 
    // If we want simple progress: reviewed / (reviewed + remaining in queue)
    // But queue length changes. Let's use sessionReviewedIds.size vs initial count.
    // Simplified approach: progress = reviewed / (reviewed + queue.length)
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
    // Re-enable buttons
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

    // 1. EF（難易度係数）の更新
    // Again: -0.2, Hard: -0.15, Good: 変化なし, Easy: +0.15
    // 最低値: 1.3
    let drift = 0;
    if (rating === 1) drift = -0.2;
    else if (rating === 2) drift = -0.15;
    else if (rating === 4) drift = 0.15;
    
    nextEf = Math.max(1.3, ef + drift);

    // 2. フェーズ判定: ルーキー (reps === 0) / レビュー (reps >= 1)
    const isRookie = reps === 0;

    if (rating === 1) {
        // --- AGAIN: repsを0にリセット → ルーキーに戻す ---
        nextReps = 0;
        nextInterval = 0; // dueDate計算で10分後に設定
    }
    else if (isRookie) {
        // --- ルーキーフェーズ: 固定ステップで卒業 ---
        if (rating === 2) {       // Hard → 1日後
            nextInterval = 1;
            nextReps = 1;
        } else if (rating === 3) { // Good → 2日後
            nextInterval = 2;
            nextReps = 1;
        } else if (rating === 4) { // Easy → 4日後
            nextInterval = 4;
            nextReps = 1;
        }
    }
    else {
        // --- レビューフェーズ: EFベースの乗算 ---
        const base = Math.max(interval, 1); // 最低1日をベースにする

        if (rating === 2) {        // Hard: 前回と同じ or 1.2倍
            nextInterval = base * 1.2;
        } else if (rating === 3) { // Good: EFをフル適用
            nextInterval = base * nextEf;
        } else if (rating === 4) { // Easy: EF × 1.3ボーナス
            nextInterval = base * nextEf * 1.3;
        }

        // ガードレール: Good は最低でも Hard + 1日
        if (rating === 3) {
            const hardInterval = base * 1.2;
            if (nextInterval <= hardInterval) {
                nextInterval = hardInterval + 1;
            }
        }
        if (rating === 4) {
            // Easy は Good 以上を保証（Goodの計算を再現）
            let goodInterval = base * nextEf;
            const hardInterval = base * 1.2;
            if (goodInterval <= hardInterval) {
                goodInterval = hardInterval + 1;
            }
            if (nextInterval <= goodInterval) {
                nextInterval = goodInterval + 1;
            }
        }

        nextReps = reps + 1;
    }

    // 3. Fuzz（ランダム散布）: 3日超の間隔に ±5% のゆらぎ
    if (nextInterval > 3) {
        const fuzz = 0.95 + Math.random() * 0.1; // 0.95 ~ 1.05
        nextInterval = nextInterval * fuzz;
    }

    // 4. dueDate の計算
    const now = Date.now();
    let dueDate;
    
    if (nextInterval === 0) {
        dueDate = now + 10 * 60 * 1000; // 10分後
    } else {
        dueDate = now + (nextInterval * 24 * 60 * 60 * 1000);
    }

    return { interval: nextInterval, reps: nextReps, ef: nextEf, dueDate };
}

function updateButtonLabels() {
    if (!currentCard) return;
    [1,2,3,4].forEach((r, i) => {
        const res = calculateNextState(currentCard, r);
        const ids = ['lbl-again', 'lbl-hard', 'lbl-good', 'lbl-easy'];
        let txt;
        if (res.interval === 0) txt = "10m";
        else if (res.interval < 1) { // e.g. 10m or 12h
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

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
    // Study View Shortcuts
    if (document.getElementById('study-view').style.display === 'flex') {
        const cardObj = document.getElementById('card-obj');
        const isFlipped = cardObj.classList.contains('is-flipped');
        
        if (e.code === 'Space' || e.key === 'Enter') {
            e.preventDefault(); // Prevent scrolling
            // Toggle Flip
            if (!currentCard) return;
            const controls = document.getElementById('controls');
            if (!controls.classList.contains('visible')) {
                controls.classList.add('visible');
                // Re-enable buttons? logic is weird. renderCard resets buttons to enabled.
                // rateCard disables them.
                // If controls are hidden (new card), buttons SHOULD be enabled.
                // updateButtonLabels just updates text.
                updateButtonLabels();
            }
            cardObj.classList.toggle('is-flipped');
        } else if (isFlipped) {
            // Rate 1-4
            if (e.key === '1') rateCard(1);
            if (e.key === '2') rateCard(2);
            if (e.key === '3') rateCard(3);
            if (e.key === '4') rateCard(4);
        }
        
        // Undo
        if (e.key === 'z' || e.key === 'Z') {
            if (!document.getElementById('btnUndo').disabled) handleUndo();
        }
    }
});


function showLoading(show) { document.getElementById('loading').style.display = show ? 'flex' : 'none'; }

// --- Service Worker Registration ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker registered!', reg))
            .catch(err => console.log('Service Worker registration failed:', err));
    });
}
