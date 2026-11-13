# Pico CSS

Trang cấu hình Wi-Fi sử dụng Pico CSS phiên bản 2.1.1, được nhúng trong firmware để phục vụ trực tiếp từ ESP32.

- Mã nguồn: [picocss/pico](https://github.com/picocss/pico).
- Gói sử dụng: [@picocss/pico 2.1.1](https://www.npmjs.com/package/@picocss/pico/v/2.1.1).
- Tệp gốc: `package/css/pico.min.css`, dung lượng 83.319 byte.
- Bản phân phối: [pico-2.1.1.tgz](https://registry.npmjs.org/@picocss/pico/-/pico-2.1.1.tgz).

`PicoCss.cpp` chứa nội dung CSS trong mảng `WifiPortal::kPicoCss`, khai báo bằng `PROGMEM`. `PicoCss.h` cung cấp khai báo để phần xử lý HTTP sử dụng.

Pico CSS được phát hành theo giấy phép MIT. Bản quyền © 2019–2024 Pico và nội dung giấy phép được giữ trong [LICENSE.pico](./LICENSE.pico), cùng phần chú thích bản quyền trong CSS.

## Kiểm tra tệp nguồn

SHA-256 của nội dung CSS gốc:

```text
fbc9a63fc9fc9f72d12fd7fc9806e11fa9f77ae4f9cad146b27003a1119ba3db
```

Mã kiểm tra SHA-512 của gói npm:

```text
sha512-kIDugA7Ps4U+2BHxiNHmvgPIQDWPDU4IeU6TNRdvXQM1uZX+FibqDQT2xUOnnO2yq/LUHcwnGlu1hvf4KfXnMg==
```

Khi thay phiên bản, cần thay nội dung CSS nhúng, cập nhật thông tin nguồn và giữ giấy phép đi kèm.
