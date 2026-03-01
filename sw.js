const CACHE_NAME = '1.8.0'; // バージョン管理
const urlsToCache = [
    './',              // index.html
    './index.html',
    './manifest.json',
    './css/style.css',     // CSSファイル
    './js/script.js',// JSファイル
    './js/offline-check.js',
    './js/firebase-init.js',
    './img/logo.png', // 画像
    'https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg'
];

// インストール時にキャッシュする
self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
        .then(function(cache) {
            console.log('Opened cache');
            return cache.addAll(urlsToCache).catch(err => {
                console.error('キャッシュの登録に失敗しました。ファイル名やパスを確認してください:', err);
            });
        })
    );
    // 新しいService Workerをすぐにアクティブにする
    self.skipWaiting();
});

// アクティベート時に古いキャッシュを削除
self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.filter(function(cacheName) {
                    // 現在のキャッシュ名以外を削除対象にする
                    return cacheName !== CACHE_NAME;
                }).map(function(cacheName) {
                    console.log('古いキャッシュを削除:', cacheName);
                    return caches.delete(cacheName);
                })
            );
        })
    );
    // すべてのクライアントを新しいService Workerで制御
    self.clients.claim();
});

// Stale-While-Revalidate戦略でフェッチ
self.addEventListener('fetch', function(event) {
    // Firebase等の外部APIリクエストはキャッシュしない
    if (event.request.url.includes('firebaseio.com') ||
        event.request.url.includes('googleapis.com') ||
        event.request.url.includes('gstatic.com')) {
        return;
    }

    event.respondWith(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.match(event.request, { ignoreSearch: true }).then(function(cachedResponse) {
                // ネットワークから最新版を取得（バックグラウンド）
                const fetchPromise = fetch(event.request).then(function(networkResponse) {
                    // 成功したレスポンスのみキャッシュを更新
                    if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                        cache.put(event.request, networkResponse.clone());
                    }
                    return networkResponse;
                }).catch(function(error) {
                    console.log('ネットワークエラー:', error);
                    // ネットワークエラー時はキャッシュを返す（下で処理）
                    return cachedResponse;
                });

                // キャッシュがあればすぐに返し、なければネットワークを待つ
                return cachedResponse || fetchPromise;
            });
        })
    );
});


// ==========================================
// ここからプッシュ通知（バックグラウンド）を受け取るための設定
// Service Worker内では importScripts でFirebaseを読み込みます
// ==========================================
importScripts('https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCLJG-ExZC7dVOcSL0Tfzdv965ewCj_uGs",
  projectId: "flipcard-318f3",
  messagingSenderId: "517432601240",
  appId: "1:517432601240:web:9df881ed3f3c3b3bbb3eed"
});

const messaging = firebase.messaging();

// --- sw.js の一番下を以下に差し替え ---

// バックグラウンドで通知を受け取った時の処理
messaging.onBackgroundMessage(function(payload) {
  const notificationTitle = payload.data.title || 'SmartSRS';
  const notificationOptions = {
    body: payload.data.body || '',
    icon: './img/logo.png',
    data: {
      url: payload.data ? payload.data.url : './'
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// 👇 追加：通知をクリックした時の動作
self.addEventListener('notificationclick', function(event) {
  event.notification.close(); // 通知を閉じる

  // 通知に含まれているURLを取得
  const urlToOpen = event.notification.data.url || './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // すでにアプリが開いていればそこにフォーカス
      for (const client of clientList) {
        if (client.url.includes('SmartSRS') && 'focus' in client) {
          return client.focus().then(c => c.navigate(urlToOpen));
        }
      }
      // 開いていなければ新しく開く
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});