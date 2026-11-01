#include "PortalPages.h"

#include <pgmspace.h>

namespace WifiPortal {
const char kSetupPage[] PROGMEM = R"PORTAL(<!doctype html>
<html lang="vi" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cấu hình Wi-Fi</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/wifi/pico.min.css">
  <link rel="stylesheet" href="/wifi/portal.css">
  <script src="/wifi/portal.js" defer></script>
</head>
<body>
  <main class="container">
    <header class="portal-heading">
      <h1>Kết nối Wi-Fi</h1>
      <p>Chọn mạng để thiết bị bắt đầu hoạt động.</p>
    </header>
    <article>
      <header>
        <strong>Thiết lập mạng</strong>
        <small>Chỉ cần thực hiện khi đổi Wi-Fi.</small>
      </header>
      <form method="post" action="/save" id="wifiForm">
        <label for="ssidSel">Mạng Wi-Fi</label>
        <!-- Select hoat dong ca trong trinh duyet captive portal. -->
        <select id="ssidSel" name="ssid" required disabled aria-busy="true" aria-describedby="scanStatus">
          <option value="">— Đang quét Wi-Fi… —</option>
        </select>
        <div class="scan-row">
          <small id="scanStatus" role="status" aria-live="polite" aria-busy="true">Đang tìm mạng gần bạn…</small>
          <button type="button" id="rescan" class="outline secondary" disabled>Quét lại</button>
        </div>
        <label for="ssidManual">Hoặc nhập tên mạng</label>
        <input id="ssidManual" name="ssidManual" placeholder="Tên Wi-Fi ẩn hoặc mạng khác"
               autocomplete="off" autocapitalize="none" spellcheck="false"
               aria-describedby="manualHelp">
        <small id="manualHelp">Nếu nhập ở đây, thiết bị sẽ dùng tên mạng này.</small>
        <label for="wifiPassword">Mật khẩu</label>
        <div class="password-field">
          <input type="password" id="wifiPassword" name="pass" autocomplete="new-password"
                 placeholder="Mật khẩu Wi-Fi" aria-describedby="passwordHelp">
          <button type="button" id="showPassword" class="password-toggle"
                  aria-label="Hiện mật khẩu" aria-controls="wifiPassword" aria-pressed="false"
                  title="Hiện mật khẩu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/>
              <circle cx="12" cy="12" r="3"/>
              <path class="eye-slash" d="m3 3 18 18"/>
            </svg>
          </button>
        </div>
        <small id="passwordHelp">Để trống nếu mạng không có mật khẩu.</small>
        <button type="submit" id="connectButton">Lưu và kết nối</button>
        <small id="connectStatus" role="status" aria-live="polite"></small>
      </form>
    </article>
    <footer class="portal-footer">Thiết lập trực tiếp trên thiết bị · Không cần Internet</footer>
  </main>
</body>
</html>
)PORTAL";

const char kPortalCss[] PROGMEM = R"CSS(:root {
  --pico-font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  --pico-font-size: 100%;
  --pico-border-radius: 0.75rem;
  --pico-primary: #087e8b;
  --pico-primary-background: #087e8b;
  --pico-primary-border: #087e8b;
  --pico-primary-hover-background: #066772;
  --pico-primary-hover-border: #066772;
  --pico-primary-focus: rgba(8, 126, 139, 0.2);
}
body { min-height: 100vh; background: #f2f7f8; }
main.container { max-width: 32rem; padding: 2.5rem 1rem 1.5rem; }
.portal-heading { margin-bottom: 1.5rem; }
h1 { margin: 0.5rem 0; font-size: 2rem; }
.portal-heading p, .portal-footer, small { color: var(--pico-muted-color); }
.portal-heading p { margin: 0; }
article { margin: 0; padding: 1.5rem; border: 1px solid #e0e9ec; box-shadow: 0 8px 32px #1637470a; }
article > header { margin: -1.5rem -1.5rem 1.5rem; padding: 1rem 1.5rem; }
article > header small { display: block; margin-top: 0.25rem; }
.scan-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin: -0.25rem 0 1.25rem; }
.scan-row small { margin: 0; }
#scanStatus[aria-busy="true"] { white-space: normal; }
#rescan { flex-shrink: 0; width: auto; margin: 0; padding: 0.3rem 0.65rem; font-size: 0.8rem; }
.password-field { position: relative; margin-bottom: 0.25rem; }
.password-field input { margin-bottom: 0; padding-right: 3.5rem; }
.password-field input::-ms-reveal { display: none; }
button.password-toggle {
  position: absolute; top: 50%; right: 0.25rem; transform: translateY(-50%);
  display: grid; place-items: center; width: 2.75rem; height: 2.75rem;
  margin: 0; padding: 0.65rem; border: 0; border-radius: 0.5rem;
  background: transparent; color: var(--pico-muted-color); box-shadow: none;
}
button.password-toggle:hover { background: #087e8b0d; color: var(--pico-primary); }
button.password-toggle:focus-visible { outline: 2px solid var(--pico-primary); outline-offset: -2px; }
.password-toggle svg { width: 1.25rem; height: 1.25rem; }
.password-toggle .eye-slash { display: none; }
.password-toggle[aria-pressed="true"] .eye-slash { display: inline; }
#passwordHelp { display: block; margin-bottom: 1.25rem; }
#connectButton { margin-bottom: 0.5rem; }
#connectStatus:empty { display: none; }
.portal-footer { margin-top: 1.25rem; text-align: center; font-size: 0.75rem; }
@media (max-width: 380px) {
  main.container { padding-top: 1.5rem; }
  article { padding: 1rem; }
  article > header { margin: -1rem -1rem 1rem; padding: 1rem; }
  h1 { font-size: 1.75rem; }
}
)CSS";

const char kPortalScript[] PROGMEM = R"JS((function () {
  'use strict';
  var form = document.getElementById('wifiForm');
  var select = document.getElementById('ssidSel');
  var manual = document.getElementById('ssidManual');
  var password = document.getElementById('wifiPassword');
  var rescan = document.getElementById('rescan');
  var status = document.getElementById('scanStatus');
  var connect = document.getElementById('connectButton');
  var connecting = false;
  var scanning = false;
  var timer;
  var deadlineTimer;
  var controller;
  var generation = 0;
  var failures = 0;

  function cancelScan() {
    generation += 1;
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
    if (controller) controller.abort();
    controller = null;
  }

  function isCurrent(scan) {
    return scanning && !connecting && scan === generation;
  }

  function updateRequired() {
    select.required = manual.value.length === 0;
    connect.disabled = connecting || (scanning && select.required);
  }

  function placeholder(text) {
    select.textContent = '';
    var option = document.createElement('option');
    option.value = '';
    option.textContent = text;
    select.appendChild(option);
  }

  function finishScan(message) {
    cancelScan();
    scanning = false;
    status.textContent = message;
    status.removeAttribute('aria-busy');
    select.disabled = false;
    select.removeAttribute('aria-busy');
    rescan.disabled = false;
    updateRequired();
  }

  function loadNetworks(scan) {
    if (!isCurrent(scan)) return;
    var options = { cache: 'no-store' };
    if (controller) options.signal = controller.signal;
    fetch('/scan', options).then(function (response) {
      if (!isCurrent(scan)) return;
      if (!response.ok) throw new Error('scan');
      return response.json();
    }).then(function (data) {
      if (!isCurrent(scan)) return;
      if (!data || (data.status !== 'scanning' && data.status !== 'done') ||
          (data.status === 'done' && !Array.isArray(data.networks))) {
        throw new Error('scan');
      }
      failures = 0;
      if (data.status === 'scanning') {
        timer = setTimeout(function () { loadNetworks(scan); }, 800);
        return;
      }
      var strongest = null;
      placeholder('— Chọn mạng Wi-Fi —');
      data.networks.forEach(function (network) {
        var option = document.createElement('option');
        option.value = network.ssid;
        option.textContent = network.ssid + ' (' + network.rssi + ' dBm)';
        select.appendChild(option);
        if (network.ssid && (!strongest || network.rssi > strongest.rssi)) {
          strongest = network;
        }
      });
      if (strongest) select.value = strongest.ssid;
      if (!data.networks.length) {
        placeholder('— Không thấy mạng nào —');
        finishScan('Nhập tên mạng bên dưới hoặc quét lại.');
      } else {
        finishScan('Tìm thấy ' + data.networks.length + ' mạng Wi-Fi.');
      }
    }).catch(function () {
      if (!isCurrent(scan)) return;
      failures += 1;
      if (failures < 3) {
        status.textContent = 'Đang thử quét lại…';
        timer = setTimeout(function () { loadNetworks(scan); }, 1000);
      } else {
        finishScan('Không thể quét. Bạn vẫn có thể nhập tên mạng.');
      }
    });
  }

  function startScan() {
    if (connecting) return;
    cancelScan();
    var scan = generation;
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    failures = 0;
    scanning = true;
    rescan.disabled = true;
    select.disabled = true;
    select.setAttribute('aria-busy', 'true');
    status.setAttribute('aria-busy', 'true');
    status.textContent = 'Đang tìm mạng gần bạn…';
    updateRequired();
    // Independent of fetch/json completion: even a hung request must unlock the form.
    deadlineTimer = setTimeout(function () {
      if (isCurrent(scan)) {
        finishScan('Quét Wi-Fi quá thời gian. Bạn có thể nhập tên mạng hoặc quét lại.');
      }
    }, 20000);
    loadNetworks(scan);
  }

  manual.addEventListener('input', updateRequired);
  document.getElementById('showPassword').addEventListener('click', function () {
    var visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    var label = visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu';
    this.setAttribute('aria-pressed', visible ? 'true' : 'false');
    this.setAttribute('aria-label', label);
    this.setAttribute('title', label);
  });
  rescan.addEventListener('click', startScan);
  form.addEventListener('submit', function (event) {
    if (connecting || (scanning && manual.value.length === 0)) {
      event.preventDefault();
      return;
    }
    connecting = true;
    cancelScan();
    scanning = false;
    select.disabled = false;
    rescan.disabled = true;
    connect.disabled = true;
    connect.setAttribute('aria-busy', 'true');
    connect.textContent = 'Đang kết nối…';
    document.getElementById('connectStatus').textContent =
      'Vui lòng chờ thiết bị thử kết nối. Không đóng trang này.';
  });
  updateRequired();
  startScan();
}());
)JS";

// Trang ket qua tu chua CSS: AP co the tat ngay sau khi gui phan hoi.
#define RESULT_HEAD \
  "<!doctype html><html lang='vi'><head><meta charset='utf-8'>" \
  "<meta name='viewport' content='width=device-width,initial-scale=1'>" \
  "<title>Kết quả kết nối Wi-Fi</title><link rel='icon' href='data:,'>" \
  "<style>*{box-sizing:border-box}body{margin:0;background:#f2f7f8;color:#24353d;" \
  "font:16px/1.6 system-ui,-apple-system,sans-serif;padding:48px 16px}" \
  "main{max-width:440px;margin:auto;padding:28px;background:white;" \
  "border:1px solid #e0e9ec;border-radius:12px;box-shadow:0 8px 32px #1637470a}" \
  "h1{font-size:26px;line-height:1.3}" \
  "p{color:#52636b}a{display:inline-block;padding:10px 18px;background:#087e8b;" \
  "color:white;border-radius:8px;text-decoration:none}a:focus-visible{outline:3px solid #24353d;" \
  "outline-offset:4px}</style></head><body><main>"
#define RESULT_FOOT "</main></body></html>"

const char kMissingSsidPage[] PROGMEM = RESULT_HEAD
    "<h1>Chưa có tên mạng</h1>"
    "<p>Hãy chọn một mạng Wi-Fi hoặc nhập tên mạng để tiếp tục.</p>"
    "<a href='/'>Quay lại cấu hình</a>" RESULT_FOOT;

const char kSuccessPage[] PROGMEM = RESULT_HEAD
    "<h1>Kết nối thành công!</h1>"
    "<p>Thiết bị đã kết nối Wi-Fi. Mạng cấu hình sẽ tắt.</p>"
    "<p>Bạn có thể đóng trang này và kết nối lại mạng Wi-Fi thường dùng.</p>" RESULT_FOOT;

const char kFailurePage[] PROGMEM = RESULT_HEAD
    "<h1>Chưa thể kết nối</h1>"
    "<p>Kiểm tra tên mạng, mật khẩu và bảo đảm thiết bị ở trong vùng phủ sóng.</p>"
    "<p>Mạng cấu hình vẫn mở để bạn thử lại.</p>"
    "<a href='/'>Thử lại</a>" RESULT_FOOT;

#undef RESULT_HEAD
#undef RESULT_FOOT
}  // namespace WifiPortal
