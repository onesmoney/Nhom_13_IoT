# Trang cấu hình Wi-Fi của ESP32

ESP32 có trang web để chọn mạng Wi-Fi hoặc nhập tên mạng và mật khẩu. Trang được lưu trong bộ nhớ flash của thiết bị, nên điện thoại có thể mở ngay khi kết nối với điểm phát Wi-Fi của ESP32.

## Sử dụng

1. Đưa ESP32 vào chế độ cấu hình và kết nối điện thoại hoặc máy tính với điểm phát của thiết bị.
2. Mở trang cấu hình tự hiện. Nếu trang không hiện, nhập địa chỉ IP được in trên Serial.
3. Chọn mạng trong danh sách hoặc nhập SSID thủ công, điền mật khẩu rồi bấm kết nối.

Kết nối thành công thì ESP32 đóng điểm phát cấu hình. Nếu thất bại, điểm phát vẫn hoạt động để người dùng nhập lại. Tên mạng nhập tay được ưu tiên hơn mạng đang chọn trong danh sách.

Nút **Quét lại** cập nhật danh sách mạng. Trong lúc quét, người dùng vẫn có thể nhập tên mạng ẩn. Nút hiện/ẩn mật khẩu giúp kiểm tra nội dung trước khi gửi.

## Mã nguồn

| File | Nội dung |
| --- | --- |
| `src/WiFiProvisioner.cpp` | Quản lý điểm phát, kết nối mạng, DNS và xử lý yêu cầu HTTP |
| `src/wifi/PortalPages.cpp` | HTML, CSS, JavaScript và các trang thông báo kết quả |
| `src/wifi/PortalPages.h` | Khai báo tài nguyên giao diện |
| `src/wifi/vendor/PicoCss.cpp` | Thư viện Pico CSS được nhúng vào firmware |

Tài nguyên giao diện dùng `PROGMEM` và được gửi bằng `WebServer::send_P`. Trình duyệt tải CSS và JavaScript trực tiếp từ ESP32. Thông tin thư viện nằm trong [vendor/README.md](./vendor/README.md).

## Các đường dẫn HTTP

| Đường dẫn | Chức năng |
| --- | --- |
| `GET /` | Mở trang cấu hình |
| `GET /scan` | Quét mạng: trả 202 khi đang quét, 200 khi hoàn tất |
| `POST /save` | Nhận `ssid`, `ssidManual` và `pass` để kết nối |
| `GET /wifi/pico.min.css` | Pico CSS |
| `GET /wifi/portal.css` | CSS của trang cấu hình |
| `GET /wifi/portal.js` | JavaScript của trang cấu hình |

DNS và các đường dẫn kiểm tra mạng của điện thoại được chuyển về trang cấu hình. Danh sách quét tự chọn mạng có tên không rỗng và tín hiệu mạnh nhất. Khi quét lỗi, trang cho phép nhập tay hoặc thử lại.

## Biên dịch và nạp

Chạy tại thư mục gốc dự án bằng PlatformIO:

```sh
pio run -e esp32dev
pio run -e esp32dev -t upload
pio device monitor -b 115200
```

Sau khi nạp, kiểm tra việc mở trang, quét mạng và kết nối trên thiết bị thật. Trang cấu hình hoạt động trong mạng Wi-Fi của ESP32; thiết bị cần kết nối Internet để gửi số đo lên Firebase.
