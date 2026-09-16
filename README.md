# Đối soát kiểm kê Phong Vũ

Ứng dụng Streamlit đối soát tồn kho sổ sách với dữ liệu kiểm kê ERP, hỗ trợ kiểm đếm lần 2 và xuất Excel/PDF.

## Chạy local

1. Cài Python 3.9+ và tạo môi trường ảo.
2. Chạy `pip install -r requirements.txt`.
3. Sao chép `.streamlit/secrets.toml.example` thành `.streamlit/secrets.toml`, rồi điền thông tin Supabase.
4. Trong Supabase Dashboard, mở **SQL Editor** và chạy toàn bộ [supabase_schema.sql](supabase_schema.sql).
5. Chạy `python -m streamlit run app.py`.

## Deploy web bằng Streamlit Community Cloud

1. Đưa thư mục này lên một GitHub repository riêng tư.
2. Vào [share.streamlit.io](https://share.streamlit.io), chọn repository, branch và `app.py`.
3. Trong **Advanced settings > Secrets**, thêm:

```toml
SUPABASE_URL = "https://<project-ref>.supabase.co"
SUPABASE_KEY = "<service_role_key>"
SUPABASE_PUBLISHABLE_KEY = "<sb_publishable_...>"
AUTH_REDIRECT_URL = "https://<your-app>.streamlit.app"
```

Lấy các khóa ở Supabase **Project Settings > API**. `SUPABASE_KEY` chỉ dùng phía
server; `SUPABASE_PUBLISHABLE_KEY` là khóa public dành cho giao diện trình duyệt.
Không đưa secret/service-role key vào GitHub hoặc trình duyệt.

> Lưu ý: `index.html` chạy phía trình duyệt. Không chép `service_role key` vào
> `localStorage` hoặc `window.SUPABASE_KEY`. Nếu muốn SPA lưu trực tiếp, cần dùng
> Supabase Auth + RLS và chỉ cấp anon key; nếu chưa có Auth, giữ thao tác Supabase
> ở lớp Python `supabase_store.py`.

## Cấu hình Supabase Auth và email

Giao diện mặc định dùng tài khoản email/mật khẩu có tên. Vai trò và
trạng thái truy cập luôn được đọc từ bảng `profiles`; metadata do người
dùng nhập khi đăng ký chỉ gồm họ tên và tên nhân viên ERP.

1. Vào **Authentication > Providers > Email** và bật nhà cung cấp **Email**
   cùng tùy chọn đăng nhập bằng mật khẩu.
2. Giữ **Confirm email** bật cho môi trường thật. Người dùng phải xác
   nhận email, sau đó quản lý phê duyệt hồ sơ đang ở trạng thái
   `pending` trước khi họ truy cập ứng dụng.
3. Vào **Project Settings > Authentication > SMTP Settings**, bật **Custom
   SMTP** và khai báo host, port, tài khoản, mật khẩu, tên và địa chỉ
   người gửi của nhà cung cấp email. Gửi thử email xác nhận và email
   đổi mật khẩu trước khi mời nhân viên.
4. Vào **Authentication > URL Configuration**. Đặt **Site URL** là URL
   Streamlit chính thức và thêm cùng URL (kèm các URL staging/local cần
   thiết) vào **Redirect URLs** để link xác nhận và đổi mật khẩu quay
   lại đúng ứng dụng. Đặt secret `AUTH_REDIRECT_URL` thành URL đó;
   Streamlit sẽ truyền nó thành `window.AUTH_REDIRECT_URL` cho giao diện.
   Nếu không cấu hình, giao diện dùng URL trang cha từ
   `document.referrer`, sau đó mới rơi về origin hiện tại.

Trong giai đoạn chuyển đổi duy nhất, có thể hiện giao diện quản lý cũ
không cần phiên có tên bằng cách đặt biến trình duyệt sau trước khi
ứng dụng khởi tạo:

```javascript
window.ENABLE_LEGACY_ANONYMOUS = true;
```

Cờ này không được bật mặc định. Khi bật, giao diện tạo hoặc dùng lại
phiên Supabase anonymous trước khi mở giao diện cũ. Phiên anonymous chỉ
phục vụ chuyển đổi giao diện/local: RLS vẫn chặn nó đọc hoặc ghi
`inventory_sessions` và `monthly_archives` vì hai bảng này chứa serial đầy
đủ. Muốn mở các phiên cloud đã lưu, hãy đăng nhập bằng tài khoản
`manager` hoặc `admin` đang `active`.

Sau khi các tài khoản thí điểm đã được phê duyệt và kiểm tra:

1. Xóa cờ `ENABLE_LEGACY_ANONYMOUS` khỏi mẫu nhúng/deploy.
2. Vào **Authentication > Providers > Anonymous Sign-Ins** và tắt Anonymous
   Sign-Ins.

## Quản lý vòng đời tài khoản

Tài khoản tự đăng ký bắt đầu ở trạng thái `pending`. Quản lý mở
**Quản lý tài khoản** trong thanh bên để:

- phê duyệt với tên nhân viên ERP có thể chỉnh sửa;
- khóa tài khoản kèm lý do, đồng thời trả công việc chưa hoàn tất
  về trạng thái chưa phân công;
- mở khóa; hoặc
- xóa quyền đăng nhập sau khi nhập lại email để xác nhận.

Xóa tài khoản là thao tác xóa mềm: hồ sơ được đánh dấu
`deleted` và Supabase Auth bị cấm đăng nhập dài hạn. Dòng `auth.users`,
kết quả hoàn tất, snapshot người kiểm đếm và audit được giữ lại.
Edge Function không gọi API xóa Auth vì các khóa ngoại lịch sử không
dùng cascade.

Triển khai Edge Function sau khi áp dụng migration:

```bash
supabase functions deploy admin-user-lifecycle --verify-jwt
```

Thiết lập `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (hoặc
`SUPABASE_ANON_KEY`) và `SUPABASE_SERVICE_ROLE_KEY` là secret phía server
của Edge Function. Service-role key chỉ được dùng bên trong function, không
được đưa vào `index.html`, biến trình duyệt hay local storage.

## Lịch sử và bảo mật

Mỗi đợt kiểm kê được lưu trong bảng `inventory_sessions` dưới dạng JSONB; sidebar cho phép tạo, lưu và mở lại các đợt đã có. Hai file dữ liệu nguồn (tồn kho và ERP) của từng đợt cũng được lưu một lần vào bucket private `inventory-source-files` trên Supabase Storage.

Người chưa đăng nhập chỉ thấy màn hình đăng nhập/đăng ký. Tài khoản
`pending`, `locked` hoặc `deleted` không thể mở dữ liệu nghiệp vụ. Nhân viên
`counter` chỉ thấy khu vực **Kiểm đếm lần 2**; `manager` và `admin`
thấy quy trình quản lý đầy đủ. RLS và RPC trong Supabase là biên bảo
mật bắt buộc; việc ẩn tab trong trình duyệt không thay thế phân quyền phía server.
