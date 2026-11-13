# Dashboard giám sát môi trường – Nhóm 13

Dashboard hiển thị nhiệt độ, độ ẩm, ánh sáng và bụi mịn do ESP32 gửi lên Firebase Realtime Database. Người dùng có thể chọn thiết bị, xem dữ liệu gần đây hoặc tra cứu theo ngày.

Dữ liệu đi qua các thành phần sau:

```text
ESP32 → Firebase → Server Node.js/Express → Giao diện React
```

Server đọc dữ liệu từ Firebase, tính thống kê và gửi kết quả cho giao diện qua HTTP. Kết nối SSE chuyển các cập nhật mới đến trình duyệt.

## Cài đặt và chạy

Cần Node.js từ phiên bản 22 và một dự án Firebase có Realtime Database.

Từ thư mục gốc dự án:

```powershell
cd web
npm install
Copy-Item server/.env.example server/.env
```

Bước sao chép cấu hình chỉ cần thực hiện khi chưa có `server/.env`. Điền `FIREBASE_API_KEY` và `FIREBASE_DATABASE_URL` của dự án vào file này. Cơ chế đăng nhập hiện tại dùng Firebase Anonymous Authentication, nên cần bật phương thức đó trong Firebase Console.

Server tự gộp dữ liệu cũ thành các khoảng 5 phút và xóa mẫu gốc sau khi lưu kết quả. Vì vậy, cần sao lưu dữ liệu và kiểm tra quyền đọc/ghi trước lần chạy đầu. Cách gộp được mô tả trong [MEDIAN_COMPACTION.md](./MEDIAN_COMPACTION.md).

Chạy khi phát triển:

```sh
npm run dev
```

Giao diện mở tại [localhost:5173](http://localhost:5173), server dùng cổng 4000.

Để chạy bản đã build:

```sh
npm run build
npm start
```

Khi đó mở [localhost:4000](http://localhost:4000). Server phục vụ cả API và giao diện.

## Sử dụng

Chọn thiết bị, mở bộ lọc thời gian rồi bấm **Áp dụng**. Có bốn khoảng gần đây: 15 phút, 1 giờ, 6 giờ và 24 giờ. Phần lịch cho phép chọn khoảng ngày hoặc từng ngày, tối đa 31 ngày trong một yêu cầu.

Ngày được tính theo giờ Việt Nam (UTC+7). Có thể chọn từ ngày đầu tiên có dữ liệu của thiết bị đến hôm nay; ngày không có số đo sẽ hiển thị thông báo trống. Trạng thái thiết bị vẫn dựa trên dữ liệu mới nhất khi đang xem lịch sử.

Các biểu đồ và thống kê nhỏ nhất, trung bình, lớn nhất dùng cùng khoảng đã chọn. Giá trị cảm biến bị lỗi được bỏ qua, không thay bằng số 0. Biểu đồ ngắt nét ở khoảng thiếu dữ liệu; dữ liệu lịch sử đã gộp được biểu diễn bằng trung vị 5 phút.

## Cấu hình server

Các biến nằm trong `server/.env`:

| Biến | Ý nghĩa |
| --- | --- |
| `FIREBASE_API_KEY` | API key của dự án Firebase |
| `FIREBASE_DATABASE_URL` | Địa chỉ Realtime Database |
| `FIREBASE_DATA_PATH` | Nhánh dữ liệu gốc, mặc định `sensorData` |
| `PORT` | Cổng server, mặc định 4000 |
| `HISTORY_HOURS` | Số giờ dữ liệu gần đây giữ trong bộ nhớ. File mẫu đặt 24; nếu không khai báo thì dùng 168 |
| `CACHE_FILE` | Đường dẫn lưu cache, tính từ `server/`; mặc định `.cache/sensor-cache.json`. Đặt `off` để chỉ dùng RAM |
| `COMPACTION_RETAIN_DAYS` | Thời gian giữ mẫu gốc trước khi gộp, mặc định 1 ngày |
| `DEBUG_API_TOKEN` | Mã truy cập riêng cho API đếm bản ghi |

Nhánh tổng hợp là `sensorData5m`. Server cần đọc được cả nhánh này và nhánh dữ liệu gốc. Các thông số về chu kỳ, số dòng và dung lượng mỗi lượt gộp có trong `server/.env.example`.

## Lưu và tải dữ liệu

Dữ liệu gần đây được giữ trong RAM để trình duyệt không phải truy vấn Firebase mỗi lần cập nhật. Cache trên ổ đĩa giúp server khôi phục dữ liệu sau khi khởi động lại; file đang dùng có hậu tố `.mixed-v2.json`. Khi kết nối lại, server đọc phần dữ liệu còn thiếu và đối chiếu các bản tổng hợp.

Lịch sử của một ngày đã kết thúc được lưu riêng theo ngày và thiết bị trong thư mục `<CACHE_FILE>.history-v1/`. Cache này có hạn 72 giờ kể từ lúc tải xong. Xem lại hoặc bấm tải lại trong thời hạn đó vẫn dùng cache; các chỉnh sửa trên Firebase chỉ xuất hiện sau khi cache hết hạn và được tải lại. Ngày hôm nay được đọc từ Firebase.

Khi mất kết nối, phần dữ liệu đã lưu vẫn có thể xem được và được đánh dấu chưa đồng bộ. Nếu triển khai trên máy chủ có ổ đĩa tạm, cần gắn vùng lưu trữ lâu dài để giữ cache qua các lần triển khai. Mỗi bộ cache chỉ dùng cho một tiến trình ghi.

Một số giới hạn cần biết:

- Danh sách thiết bị lấy từ dữ liệu gần đây; thiết bị đã ngừng gửi lâu có thể không xuất hiện.
- Ngày đầu tiên có dữ liệu được lưu trong RAM 24 giờ. Khởi động lại server sẽ tìm lại mốc này.
- Truy vấn lịch sử có giới hạn số dòng và dung lượng. Nếu khoảng chọn quá lớn, cần chia thành các khoảng nhỏ hơn.
- Bản ghi gửi quá trễ hoặc có đồng hồ sai có thể nằm ngoài khoảng tìm kiếm theo khóa Firebase. Khi `timestamp = 0`, server dùng thời gian trong khóa bản ghi.
- Việc sửa hoặc xóa dữ liệu cũ trực tiếp trên Firebase có thể không được cache phát hiện ngay.

## Các API chính

| API | Nội dung |
| --- | --- |
| `GET /api/status` | Kết nối Firebase, tiến độ đồng bộ, cache và tác vụ gộp |
| `GET /api/devices` | Danh sách thiết bị và thời điểm gửi gần nhất |
| `GET /api/readings` | Dữ liệu biểu đồ và thống kê |
| `GET /api/availability` | Khoảng ngày có thể chọn cho thiết bị |
| `GET /api/stream` | Luồng cập nhật SSE |
| `GET /api/debug/counts` | Số khóa con trực tiếp tại các nhánh dữ liệu |

Ví dụ truy vấn số đo:

```text
/api/readings?range=1h
/api/readings?dates=2026-11-01,2026-11-02
/api/readings?date=2026-11-01&mode=day
```

Thêm `device=<MAC>` để lọc theo thiết bị. API cũng hỗ trợ `mode=week` với tham số `date`, tính tuần từ thứ Hai đến Chủ nhật. Mỗi yêu cầu chỉ dùng một cách chọn thời gian.

Các API dữ liệu hiện chưa có cơ chế đăng nhập người dùng. Riêng `/api/debug/counts` chỉ cho phép kết nối từ máy đang chạy server khi chưa đặt token; nếu đặt `DEBUG_API_TOKEN`, mọi yêu cầu phải có header `Authorization: Bearer <token>`. Khi đưa server qua proxy công khai, cần đặt token hoặc chặn API này tại proxy.

## Kiểm tra khi gặp lỗi

Mở [API trạng thái](http://localhost:4000/api/status) và xem log terminal. `readiness.ready` cho biết dữ liệu đã sẵn sàng; trạng thái kết nối online chưa có nghĩa là đã tải xong dữ liệu.

Nếu không tải được số đo, kiểm tra cấu hình Firebase, Anonymous Authentication và quyền đọc hai nhánh. Nếu có lỗi gộp, xem phần `compaction` trong trạng thái và quyền ghi/xóa của server. Quyền xóa dữ liệu cần giới hạn cho danh tính server; đăng nhập ẩn danh hiện tại không tự phân biệt server với các tài khoản ẩn danh khác.

Cấu trúc mã nguồn được mô tả trong [ARCHITECTURE.md](./ARCHITECTURE.md).
