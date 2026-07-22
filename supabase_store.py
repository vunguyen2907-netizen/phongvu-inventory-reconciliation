"""Lớp lưu trữ lịch sử kiểm kê trên Supabase.

Không chứa khoá bí mật trong mã nguồn. URL và key được lấy từ Streamlit
secrets (khi deploy) hoặc biến môi trường (khi chạy local).
"""

import datetime as dt
import json
import os
import re
from typing import Any, Optional

import pandas as pd
import streamlit as st
from supabase import Client, create_client

SOURCE_BUCKET = "inventory-source-files"


def _setting(name: str) -> Optional[str]:
    """Đọc cấu hình mà không làm app lỗi khi chưa tạo secrets."""
    value = os.getenv(name)
    if value:
        return value
    try:
        return st.secrets.get(name)
    except Exception:
        return None


def is_configured() -> bool:
    return bool(_setting("SUPABASE_URL") and _setting("SUPABASE_KEY"))


@st.cache_resource(show_spinner=False)
def get_client() -> Client:
    url = _setting("SUPABASE_URL")
    key = _setting("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("Chưa cấu hình SUPABASE_URL và SUPABASE_KEY.")
    return create_client(url, key)


def dataframe_to_payload(df: Optional[pd.DataFrame]) -> Optional[dict[str, Any]]:
    if df is None:
        return None
    # JSON của pandas chuẩn hoá NaN/NaT thành null và hỗ trợ kiểu số của numpy.
    return json.loads(df.to_json(orient="split", date_format="iso"))


def dataframe_from_payload(payload: Optional[dict[str, Any]]) -> Optional[pd.DataFrame]:
    if not payload:
        return None
    return pd.DataFrame(payload["data"], columns=payload["columns"])


def save_inventory_session(
    session_id: Optional[str],
    session_name: str,
    df_recon: Optional[pd.DataFrame],
    df_count_l2: Optional[pd.DataFrame],
    df_check_detail: Optional[pd.DataFrame],
    source_files: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Tạo hoặc cập nhật một đợt kiểm kê; trả về bản ghi Supabase."""
    data = {
        "df_recon": dataframe_to_payload(df_recon),
        "df_count_l2": dataframe_to_payload(df_count_l2),
        "df_check_detail": dataframe_to_payload(df_check_detail),
        "source_files": source_files or [],
    }
    row = {"session_name": session_name.strip() or "Đợt kiểm kê chưa đặt tên", "data": data}
    client = get_client()
    if session_id:
        # Upsert giúp tạo session trước khi upload file gốc, đồng thời cập nhật
        # các lần lưu sau chỉ với cùng một id.
        row["id"] = session_id
        response = client.table("inventory_sessions").upsert(row, on_conflict="id").execute()
    else:
        response = client.table("inventory_sessions").insert(row).execute()
    if not response.data:
        raise RuntimeError("Supabase không trả về dữ liệu sau khi lưu.")
    return response.data[0]


@st.cache_data(ttl=30, show_spinner=False)
def list_inventory_sessions() -> list[dict[str, Any]]:
    """Cache ngắn hạn để sidebar không gọi Supabase mỗi lần Streamlit rerun."""
    response = (
        get_client()
        .table("inventory_sessions")
        .select("id, session_name, created_at, updated_at")
        .order("updated_at", desc=True)
        .execute()
    )
    return response.data or []


def _safe_storage_path(path: str) -> str:
    """Chỉ giữ tên file an toàn cho object path của Supabase Storage."""
    return re.sub(r"[^A-Za-z0-9._/-]", "_", path)


def _ensure_source_bucket(client: Client) -> None:
    try:
        client.storage.get_bucket(SOURCE_BUCKET)
    except Exception:
        # Service key chạy ở server Streamlit có thể tạo bucket private. Nếu
        # một phiên khác vừa tạo, upload bên dưới vẫn là kiểm tra cuối cùng.
        try:
            client.storage.create_bucket(SOURCE_BUCKET, options={"public": False})
        except Exception:
            client.storage.get_bucket(SOURCE_BUCKET)


def upload_source_files(files: list[dict[str, Any]]) -> None:
    """Lưu file Excel/CSV gốc của một đợt vào bucket private, chỉ upload một lần."""
    if not files:
        return
    client = get_client()
    _ensure_source_bucket(client)
    bucket = client.storage.from_(SOURCE_BUCKET)
    for item in files:
        bucket.upload(
            _safe_storage_path(item["path"]),
            item["content"],
            file_options={
                "content-type": item.get("content_type") or "application/octet-stream",
                "upsert": "true",
            },
        )


def download_source_file(path: str) -> bytes:
    """Tải lại file nguồn đã lưu khi người dùng cần đối chiếu."""
    return get_client().storage.from_(SOURCE_BUCKET).download(_safe_storage_path(path))


def load_inventory_session(session_id: str) -> dict[str, Any]:
    response = (
        get_client().table("inventory_sessions").select("*").eq("id", session_id).single().execute()
    )
    if not response.data:
        raise RuntimeError("Không tìm thấy đợt kiểm kê đã chọn.")
    return response.data


def display_time(value: Optional[str]) -> str:
    if not value:
        return ""
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().strftime("%d/%m/%Y %H:%M")
    except (TypeError, ValueError):
        return str(value)
