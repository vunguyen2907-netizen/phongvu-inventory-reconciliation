import streamlit as st
import os
import json


def build_embedded_html(html_code: str, domain_code: str, public_url: str, public_key: str) -> str:
    public_config = (
        "<script>"
        f"window.SUPABASE_URL={json.dumps(public_url)};"
        f"window.SUPABASE_KEY={json.dumps(public_key)};"
        "</script>"
    )
    html_code = html_code.replace("</head>", f"{public_config}</head>", 1)
    domain_script = f"<script>{domain_code.replace('</script', '<\\/script')}</script>"
    return html_code.replace(
        '<script type="text/babel">',
        f'{domain_script}<script type="text/babel">',
        1,
    )


st.set_page_config(
    page_title="Hệ thống Tự động Xử lý & Đối soát Dữ liệu Kiểm kê - Phong Vũ",
    layout="wide",
    initial_sidebar_state="collapsed"
)

# Hide Streamlit default headers/footers for a full native Web App feel
st.markdown("""
<style>
    #MainMenu {visibility: hidden;}
    footer {visibility: hidden;}
    header {visibility: hidden;}
    [data-testid="stHeader"] {display: none;}
    .block-container {
        padding-top: 0rem !important;
        padding-bottom: 0rem !important;
        padding-left: 0rem !important;
        padding-right: 0rem !important;
        max-width: 100% !important;
    }
    iframe {
        border: none !important;
        width: 100% !important;
    }
</style>
""", unsafe_allow_html=True)

html_path = os.path.join(os.path.dirname(__file__), "index.html")
if os.path.exists(html_path):
    with open(html_path, "r", encoding="utf-8") as f:
        html_code = f.read()
    # Chỉ truyền publishable/anon key xuống trình duyệt. Tuyệt đối không truyền
    # SUPABASE_KEY vì biến này đang dùng secret/service-role key ở phía server.
    public_url = st.secrets.get("SUPABASE_URL", os.getenv("SUPABASE_URL", ""))
    public_key = (
        st.secrets.get("SUPABASE_PUBLISHABLE_KEY", "")
        or st.secrets.get("SUPABASE_ANON_KEY", "")
        or os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
        or os.getenv("SUPABASE_ANON_KEY", "")
    )
    domain_path = os.path.join(os.path.dirname(__file__), "recount_domain.js")
    with open(domain_path, "r", encoding="utf-8") as domain_file:
        domain_code = domain_file.read()
    html_code = build_embedded_html(html_code, domain_code, public_url, public_key)
    st.components.v1.html(html_code, height=950, scrolling=True)
else:
    st.error("Không tìm thấy file index.html!")
