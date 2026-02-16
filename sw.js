const CACHE_NAME = 'StudyReport-v3'; // バージョン管理
const urlsToCache = [
    './',              // index.html
    './index.html',
    './manifest.json',
    './css/style.css',     // CSSファイル
    './js/script.js',     // JSファイル
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
            return cache.match(event.request).then(function(cachedResponse) {
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
