# Giao diện cấu hình Wi-Fi ESP32

Portal chạy trực tiếp trên ESP32, dùng để chọn mạng hoặc nhập SSID thủ công và gửi mật khẩu qua form HTML. Không cần Internet, CDN hay bước build frontend riêng.

## Vai trò các tệp

- `src/wifi/PortalPages.h`: khai báo các tài nguyên trong namespace `WifiPortal`.
- `src/wifi/PortalPages.cpp`: chứa HTML cấu hình (`kSetupPage`), CSS riêng (`kPortalCss`), JavaScript (`kPortalScript`) và ba trang kết quả thiếu SSID/thành công/thất bại. JavaScript quét bất đồng bộ, cập nhật trạng thái, bật/tắt hiện mật khẩu và chống gửi form lặp.
- `src/wifi/vendor/PicoCss.h`, `PicoCss.cpp`: nhúng Pico CSS **2.1.1** đã ghim phiên bản, phục vụ tại chỗ để hoạt động offline. Nguồn, checksum và cách cập nhật nằm trong `vendor/README.md`; giấy phép MIT nằm trong `vendor/LICENSE.pico`. Không tải Pico từ CDN khi mở portal.
- `src/WiFiProvisioner.cpp`: quản lý AP/STA, DNS captive portal, đăng ký route, quét Wi-Fi và xử lý thông tin gửi lên.
- `test/wifi/preview.py`: máy chủ xem thử trên máy tính; đọc trực tiếp tài nguyên C++ thay vì duy trì bản HTML/JS khác.
- `test/wifi/portal.test.cjs`: kiểm thử bằng module tích hợp Node.js (`node:test`, `assert`, `vm`), trích xuất và chạy đúng `kPortalScript`. DOM, fetch và timer giả tối thiểu; không cài gói ngoài.

## Lưu trong flash và phục vụ HTTP

Các mảng `const char ...[] PROGMEM` giữ tài nguyên nhúng trong flash. `WebServer::send_P` gửi trực tiếp nội dung này với MIME và charset phù hợp, tránh tạo bản sao toàn bộ trang/CSS thành `String` trong heap. Khi sửa raw string C++, giữ đúng dấu phân cách đóng/mở.

Trang kết quả tự chứa CSS vì AP có thể tắt ngay sau khi phản hồi thành công; trang đó không phụ thuộc việc tải thêm CSS/JS từ thiết bị.

## Route trên thiết bị

| Route | Vai trò |
| --- | --- |
| `GET /` | Trang cấu hình Wi-Fi. |
| `GET /wifi/pico.min.css` | Pico CSS nhúng, `text/css; charset=utf-8`. |
| `GET /wifi/portal.css` | CSS riêng của portal. |
| `GET /wifi/portal.js` | JavaScript, `application/javascript; charset=utf-8`. |
| `GET /scan` | JSON: HTTP 202 với `status: "scanning"` khi đang quét; HTTP 200 với `status: "done"` và `networks: [{ssid, rssi}]` khi xong. |
| `POST /save` | Nhận `ssid`, `ssidManual`, `pass`; ưu tiên SSID nhập tay nếu khác rỗng. Thiếu SSID trả HTTP 400; thử kết nối xong trả trang thành công hoặc thất bại (HTTP 200). Thành công tắt AP; thất bại giữ AP để thử lại. |

Các URL kiểm tra captive portal như `/generate_204`, `/gen_204`, `/hotspot-detect.html`, `/library/test/success.html`, `/ncsi.txt`, `/connecttest.txt`, `/fwlink`, `/redirect` và URL không khớp được chuyển hướng HTTP 302 về `/` tại IP của AP. DNS wildcard hướng truy vấn về thiết bị.

Trong lúc quét, select bị khóa và trạng thái hiển thị vòng xoay có sẵn của Pico CSS qua `aria-busy`. Khi quét xong, select mở lại và tự chọn mạng có SSID không rỗng với RSSI cao nhất (ví dụ -40 dBm mạnh hơn -70 dBm), kể cả sau khi quét lại; nếu bằng nhau chọn mạng xuất hiện trước. Nút kết nối bị khóa trong lúc quét trừ khi đã nhập SSID thủ công.

JavaScript thăm dò sau 800 ms khi đang quét. Lỗi mạng/HTTP/đọc JSON được thử lại sau 1000 ms và dừng khi có ba lỗi liên tiếp; phản hồi hợp lệ đặt lại bộ đếm. Nút **Quét lại** bắt đầu lượt mới. Danh sách rỗng hoặc lỗi vẫn cho nhập SSID tay. SSID hiển thị qua `textContent`, không diễn giải thành HTML. Khi gửi form, chỉ khóa nút kết nối/quét lại, giữ các trường có tên ở trạng thái enabled để trình duyệt vẫn gửi đủ dữ liệu.

## Build firmware

Chạy từ thư mục gốc repository, với PlatformIO đã cài và môi trường ESP32 sẵn sàng:

```sh
pio run -e esp32dev
```

Lệnh dùng môi trường `esp32dev` trong `platformio.ini`. Không cần npm hoặc build CSS/JavaScript. Lần đầu PlatformIO có thể cần Internet để tải toolchain/thư viện; việc sử dụng portal sau khi nạp firmware không cần Internet.

## Xem thử không cần ESP32

Chạy từ thư mục gốc repository, dùng Python 3 và thư viện chuẩn:

```sh
python -I test/wifi/preview.py
```

Máy chủ mặc định chỉ lắng nghe `127.0.0.1:8765`; có thể đổi bằng `--port 8766`. Dừng bằng Ctrl+C.

- Bình thường: <http://127.0.0.1:8765/> — `/scan` trả 202 rồi 200, có cả SSID chứa ký tự đặc biệt.
- Không có mạng: <http://127.0.0.1:8765/?scenario=empty>.
- Lỗi quét: <http://127.0.0.1:8765/?scenario=error> — `/scan` trả HTTP 503 để kiểm tra giới hạn thử lại.
- Xem trang thành công: <http://127.0.0.1:8765/preview/success>.
- Xem trang thất bại: <http://127.0.0.1:8765/preview/failure>.
- Xem trang thiếu SSID: <http://127.0.0.1:8765/preview/missingssid>.

Form `POST /save` trong preview chỉ mô phỏng: thiếu SSID trả trang thiếu SSID; mật khẩu `bad-test` trả thất bại; các trường hợp có SSID khác trả thành công. Không kết nối Wi-Fi thật hoặc lưu thông tin. Các route `/preview/*` chỉ có trên máy chủ xem thử, không phải route firmware. Scenario và số lượt quét được dùng chung trong tiến trình preview: nên thử từng tab để tránh ảnh hưởng lẫn nhau.

## Kiểm thử tự động

Cần Node.js có `node:test` (khuyến nghị Node.js 22 trở lên), chạy từ thư mục gốc:

```sh
node --test test/wifi/portal.test.cjs
```

Không cần `npm install`, thiết bị hay máy chủ preview. Các ca kiểm thử bao gồm:

- Quét 202 → 200, `cache: no-store`, trạng thái bận và hiển thị RSSI.
- SSID có HTML/ký tự đặc biệt được giữ nguyên dạng văn bản; kết quả rỗng.
- SSID tay bật/tắt `required` của select; khóa select và hiển thị loading khi quét, tự chọn RSSI mạnh nhất sau mỗi lượt quét.
- Giới hạn ba lỗi liên tiếp cho lỗi fetch, HTTP và JSON; đặt lại bộ đếm khi quét lại hoặc có phản hồi hợp lệ.
- Hiện/ẩn mật khẩu mà không thay đổi giá trị.
- Gửi form gốc, trạng thái bận, chặn gửi trùng, hủy timer, giữ enabled và giá trị của cả ba trường có tên.
- Phản hồi quét đang chờ không tiếp tục cập nhật giao diện/lên lịch sau khi gửi form.

Đây là unit test logic JavaScript với mô hình DOM nhỏ, không thay thế trình duyệt thật: chưa kiểm chứng layout, constraint validation, mã hóa/gửi HTTP thực tế, DNS captive portal, RAM/flash hoặc kết nối Wi-Fi trên phần cứng.

## Danh sách kiểm tra phần cứng

1. Build/nạp firmware và mở Serial ở 115200 baud. Đưa thiết bị vào chế độ cấu hình, kết nối điện thoại/laptop với AP và mở IP AP hiển thị trong log khi popup captive không tự hiện. Không chia sẻ log chứa thông tin mạng/mật khẩu.
2. Tắt dữ liệu di động/Internet ngoài và xác nhận trang, Pico CSS, CSS riêng và JavaScript vẫn tải từ ESP32. Kiểm tra điện thoại màn hình nhỏ, cuộn, bàn phím, nhãn và trạng thái đang quét; thử popup captive Android/iOS và trình duyệt thường.
3. Kiểm tra `/scan` trả 202 rồi 200; tên mạng tiếng Việt, dấu nháy, `&`, `<`/`>` hiển thị như văn bản. Thử vùng không có mạng, quét lại nhiều lần và nhập mạng ẩn bằng tay.
4. Nhập/xóa SSID tay để kiểm tra yêu cầu chọn mạng; thử mật khẩu rỗng cho mạng mở và hiện/ẩn mật khẩu. Xác nhận SSID tay được ưu tiên khi đã chọn mạng khác.
5. Gửi form và kiểm tra nút bận/chống bấm lặp, các trường `ssid`, `ssidManual`, `pass` vẫn được gửi. Kiểm tra thiếu SSID (HTTP 400), sai mật khẩu/ngoài vùng phủ sóng (AP còn mở, có thể thử lại) và thông tin đúng (trang thành công đọc được ngay cả khi AP tắt).
6. Kiểm tra DNS/chuyển hướng captive trên các hệ điều hành mục tiêu, thử ngắt kết nối khi đang quét và khởi động lại để xác nhận thông tin Wi-Fi đã lưu được dùng đúng.
