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
```

Lấy các khóa ở Supabase **Project Settings > API**. `SUPABASE_KEY` chỉ dùng phía
server; `SUPABASE_PUBLISHABLE_KEY` là khóa public dành cho giao diện trình duyệt.
Không đưa secret/service-role key vào GitHub hoặc trình duyệt.

> Lưu ý: `index.html` chạy phía trình duyệt. Không chép `service_role key` vào
> `localStorage` hoặc `window.SUPABASE_KEY`. Nếu muốn SPA lưu trực tiếp, cần dùng
> Supabase Auth + RLS và chỉ cấp anon key; nếu chưa có Auth, giữ thao tác Supabase
> ở lớp Python `supabase_store.py`.

## Lịch sử và bảo mật

Mỗi đợt kiểm kê được lưu trong bảng `inventory_sessions` dưới dạng JSONB; sidebar cho phép tạo, lưu và mở lại các đợt đã có. Hai file dữ liệu nguồn (tồn kho và ERP) của từng đợt cũng được lưu một lần vào bucket private `inventory-source-files` trên Supabase Storage.

Phiên bản hiện tại chưa có đăng nhập người dùng. Vì vậy chỉ chia sẻ URL app cho người được phép; nếu cần phân quyền theo nhân viên/chi nhánh, bước tiếp theo là thêm Supabase Auth và cột `owner_id` với RLS policy.
