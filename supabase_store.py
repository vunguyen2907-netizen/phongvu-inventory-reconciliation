"""Lớp lưu trữ lịch sử kiểm kê trên Supabase.

Không chứa khoá bí mật trong mã nguồn. URL và key được lấy từ Streamlit
secrets (khi deploy) hoặc biến môi trường (khi chạy local).

v2 — Thêm:
  - Compression (zlib + base64) để giảm payload gửi lên Supabase ~60-70%.
  - Monthly archive: lưu snapshot hàng tháng, rolling 12 tháng.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import re
import zlib
from typing import Any, Dict, List, Optional

import pandas as pd
import streamlit as st
from supabase import create_client

SOURCE_BUCKET = "inventory-source-files"
MAX_MONTHLY_ARCHIVES = 12


# ──────────────────────────────────────────────
# Config helpers
# ──────────────────────────────────────────────

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
def get_client():
    url = _setting("SUPABASE_URL")
    key = _setting("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("Chưa cấu hình SUPABASE_URL và SUPABASE_KEY.")
    return create_client(url, key)


# ──────────────────────────────────────────────
# Compression helpers
# ──────────────────────────────────────────────

def _compress_df(df: Optional[pd.DataFrame]) -> Optional[str]:
    """Serialize DataFrame → JSON → nén zlib → base64 string.

    Trả về None nếu df là None. Kết quả là chuỗi base64 an toàn lưu vào JSONB.
    """
    if df is None:
        return None
    raw_json = df.to_json(orient="split", date_format="iso")
    compressed = zlib.compress(raw_json.encode("utf-8"), level=6)
    return base64.b64encode(compressed).decode("ascii")


def _decompress_df(value: Any) -> Optional[pd.DataFrame]:
    """Giải nén base64 → zlib → JSON → DataFrame.

    Hỗ trợ cả định dạng cũ (dict payload) lẫn định dạng mới (base64 string)
    để backward-compatible với các session đã lưu trước khi nâng cấp.
    """
    if not value:
        return None
    if isinstance(value, dict):
        # Định dạng cũ: {"columns": [...], "data": [...]}
        try:
            return pd.DataFrame(value["data"], columns=value["columns"])
        except Exception:
            return None
    if isinstance(value, str):
        try:
            decompressed = zlib.decompress(base64.b64decode(value.encode("ascii")))
            payload = json.loads(decompressed.decode("utf-8"))
            return pd.DataFrame(payload["data"], columns=payload["columns"])
        except Exception:
            return None
    return None


# Giữ lại hàm cũ để không break imports từ app.py
def dataframe_to_payload(df: Optional[pd.DataFrame]) -> Optional[Dict[str, Any]]:
    if df is None:
        return None
    return json.loads(df.to_json(orient="split", date_format="iso"))


def dataframe_from_payload(payload: Any) -> Optional[pd.DataFrame]:
    """Parse payload — hỗ trợ cả dict cũ lẫn base64 string mới."""
    return _decompress_df(payload)


# ──────────────────────────────────────────────
# Inventory Sessions (đợt kiểm kê đang làm)
# ──────────────────────────────────────────────

def save_inventory_session(
    session_id: Optional[str],
    session_name: str,
    df_recon: Optional[pd.DataFrame],
    df_count_l2: Optional[pd.DataFrame],
    df_check_detail: Optional[pd.DataFrame],
    source_files: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Tạo hoặc cập nhật một đợt kiểm kê; trả về bản ghi Supabase.

    Dữ liệu DataFrame được nén bằng zlib để giảm payload ~60-70%.
    """
    data = {
        "df_recon": _compress_df(df_recon),
        "df_count_l2": _compress_df(df_count_l2),
        "df_check_detail": _compress_df(df_check_detail),
        "source_files": source_files or [],
        "_compressed": True,   # Flag để nhận biết định dạng mới
    }
    row = {"session_name": session_name.strip() or "Đợt kiểm kê chưa đặt tên", "data": data}
    client = get_client()
    if session_id:
        row["id"] = session_id
        response = client.table("inventory_sessions").upsert(row, on_conflict="id").execute()
    else:
        response = client.table("inventory_sessions").insert(row).execute()
    if not response.data:
        raise RuntimeError("Supabase không trả về dữ liệu sau khi lưu.")
    return response.data[0]


@st.cache_data(ttl=60, show_spinner=False)
def list_inventory_sessions() -> List[Dict[str, Any]]:
    """Cache 60s để sidebar không gọi Supabase liên tục khi rerun."""
    response = (
        get_client()
        .table("inventory_sessions")
        .select("id, session_name, created_at, updated_at")
        .order("updated_at", desc=True)
        .execute()
    )
    return response.data or []


def load_inventory_session(session_id: str) -> Dict[str, Any]:
    response = (
        get_client().table("inventory_sessions").select("*").eq("id", session_id).single().execute()
    )
    if not response.data:
        raise RuntimeError("Không tìm thấy đợt kiểm kê đã chọn.")
    return response.data


# ──────────────────────────────────────────────
# Source File Storage
# ──────────────────────────────────────────────

def _safe_storage_path(path: str) -> str:
    """Chỉ giữ tên file an toàn cho object path của Supabase Storage."""
    return re.sub(r"[^A-Za-z0-9._/-]", "_", path)


def _ensure_source_bucket(client: Any) -> None:
    try:
        client.storage.get_bucket(SOURCE_BUCKET)
    except Exception:
        try:
            client.storage.create_bucket(SOURCE_BUCKET, options={"public": False})
        except Exception:
            client.storage.get_bucket(SOURCE_BUCKET)


def upload_source_files(files: List[Dict[str, Any]]) -> None:
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


# ──────────────────────────────────────────────
# Monthly Archives — lưu trữ báo cáo hàng tháng
# ──────────────────────────────────────────────

def save_monthly_archive(
    year_month: str,
    label: str,
    df_summary: Optional[pd.DataFrame],
    df_recon: Optional[pd.DataFrame],
    df_detail: Optional[pd.DataFrame],
    df_count_l2: Optional[pd.DataFrame],
) -> Dict[str, Any]:
    """Upsert báo cáo tháng và tự động prune nếu vượt quá MAX_MONTHLY_ARCHIVES."""
    client = get_client()

    # Lưu label vào trong summary JSONB để tránh phụ thuộc vào cột label riêng
    summary_with_meta = None
    if df_summary is not None:
        import json as _json
        raw = _json.loads(df_summary.to_json(orient="split", date_format="iso"))
        raw["_label"] = label
        raw["_year_month"] = year_month
        import zlib as _zlib, base64 as _b64
        compressed = _zlib.compress(_json.dumps(raw).encode("utf-8"), level=6)
        summary_with_meta = _b64.b64encode(compressed).decode("ascii")
    else:
        # Không có df_summary nhưng vẫn cần lưu label
        import json as _json, zlib as _zlib, base64 as _b64
        raw = {"columns": [], "data": [], "_label": label, "_year_month": year_month}
        compressed = _zlib.compress(_json.dumps(raw).encode("utf-8"), level=6)
        summary_with_meta = _b64.b64encode(compressed).decode("ascii")

    row = {
        "year_month": year_month,
        "summary": summary_with_meta,
        "df_recon": _compress_df(df_recon),
        "df_detail": _compress_df(df_detail),
        "df_count_l2": _compress_df(df_count_l2),
    }

    response = (
        client.table("monthly_archives")
        .upsert(row, on_conflict="year_month")
        .execute()
    )
    if not response.data:
        raise RuntimeError("Supabase không trả về dữ liệu khi lưu monthly archive.")

    # Prune: xóa bản ghi cũ nhất nếu vượt quá giới hạn 12 tháng
    all_archives = (
        client.table("monthly_archives")
        .select("id, year_month")
        .order("year_month", desc=False)
        .execute()
    ).data or []

    if len(all_archives) > MAX_MONTHLY_ARCHIVES:
        ids_to_delete = [r["id"] for r in all_archives[:len(all_archives) - MAX_MONTHLY_ARCHIVES]]
        client.table("monthly_archives").delete().in_("id", ids_to_delete).execute()

    list_monthly_archives.clear()
    return response.data[0]


@st.cache_data(ttl=120, show_spinner=False)
def list_monthly_archives() -> List[Dict[str, Any]]:
    """Trả về danh sách các tháng đã lưu, mới nhất trước.
    Không select cột 'label' để tương thích cả bảng cũ lẫn mới.
    """
    response = (
        get_client()
        .table("monthly_archives")
        .select("id, year_month, created_at, updated_at")
        .order("year_month", desc=True)
        .execute()
    )
    rows = response.data or []
    # Tự tạo label từ year_month nếu không có cột label
    for r in rows:
        if "label" not in r or not r.get("label"):
            try:
                import datetime as _dt
                ym = r["year_month"]  # "2026-07"
                y, m = ym.split("-")
                r["label"] = f"Tháng {m}/{y}"
            except Exception:
                r["label"] = r.get("year_month", "")
    return rows


def load_monthly_archive(year_month: str) -> Dict[str, Any]:
    """Load toàn bộ dữ liệu của một tháng đã lưu."""
    response = (
        get_client()
        .table("monthly_archives")
        .select("*")
        .eq("year_month", year_month)
        .single()
        .execute()
    )
    if not response.data:
        raise RuntimeError(f"Không tìm thấy archive tháng {year_month}.")
    rec = response.data

    # Lấy label: ưu tiên từ cột label, rồi từ summary._label, rồi tự tạo
    label = rec.get("label", "") or ""
    df_sum = _decompress_df(rec.get("summary"))
    if not label and df_sum is None:
        # Thử đọc label từ summary raw (chưa decompress)
        pass
    # Nếu summary là base64 string, thử đọc _label từ bên trong
    _sum_raw = rec.get("summary")
    if not label and isinstance(_sum_raw, str):
        try:
            import zlib as _z, base64 as _b, json as _j
            _payload = _j.loads(_z.decompress(_b.b64decode(_sum_raw.encode())).decode())
            label = _payload.get("_label", "")
            if df_sum is None and _payload.get("columns") is not None:
                import pandas as _pd
                cols = _payload.get("columns", [])
                data = _payload.get("data", [])
                if cols:
                    df_sum = _pd.DataFrame(data, columns=cols)
        except Exception:
            pass
    if not label:
        try:
            y, m = year_month.split("-")
            label = f"Tháng {m}/{y}"
        except Exception:
            label = year_month

    return {
        "year_month": rec["year_month"],
        "label": label,
        "df_summary": df_sum,
        "df_recon": _decompress_df(rec.get("df_recon")),
        "df_detail": _decompress_df(rec.get("df_detail")),
        "df_count_l2": _decompress_df(rec.get("df_count_l2")),
        "updated_at": rec.get("updated_at"),
    }


# ──────────────────────────────────────────────
# Utility
# ──────────────────────────────────────────────

def display_time(value: Optional[str]) -> str:
    if not value:
        return ""
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().strftime("%d/%m/%Y %H:%M")
    except (TypeError, ValueError):
        return str(value)
