// Firebaseのエラーに巻き込まれないように単独で動くオフライン検知プログラム
function updateNetworkStatus() {
    const banner = document.getElementById('offline-banner');
    if (!banner) return;

    if (!navigator.onLine) {
        banner.style.display = 'block';
        document.body.style.paddingTop = '35px'; // ★追加：バナーの分だけ画面を下げる
    } else {
        banner.style.display = 'none';
        document.body.style.paddingTop = '0px';  // ★追加：オンラインに戻ったら元に戻す
    }
}

window.addEventListener('offline', updateNetworkStatus);
window.addEventListener('online', updateNetworkStatus);

// 起動時に即チェック
updateNetworkStatus();