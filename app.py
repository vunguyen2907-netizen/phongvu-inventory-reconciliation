import os
import streamlit as st
import streamlit.components.v1 as components

st.set_page_config(
    page_title="Hệ thống Tự động Xử lý & Đối soát Dữ liệu Kiểm kê - Phong Vũ",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# Hide default Streamlit padding and header for a full-screen Web App experience
st.markdown(
    """
    <style>
        #MainMenu {visibility: hidden;}
        footer {visibility: hidden;}
        header {visibility: hidden;}
        .block-container {
            padding-top: 0rem !important;
            padding-bottom: 0rem !important;
            padding-left: 0rem !important;
            padding-right: 0rem !important;
            max-width: 100% !important;
        }
    </style>
""",
    unsafe_allow_html=True,
)

# Read Supabase secrets
supabase_url = ""
supabase_key = ""
try:
    supabase_url = os.getenv("SUPABASE_URL") or st.secrets.get("SUPABASE_URL", "")
    supabase_key = os.getenv("SUPABASE_KEY") or st.secrets.get("SUPABASE_KEY", "")
except Exception:
    pass

# Read SPA index.html
html_file_path = os.path.join(os.path.dirname(__file__), "index.html")
if os.path.exists(html_file_path):
    with open(html_file_path, "r", encoding="utf-8") as f:
        html_code = f.read()

    # Inject Supabase credentials into window object
    config_script = f"""
    <script>
        window.SUPABASE_URL = "{supabase_url}";
        window.SUPABASE_KEY = "{supabase_key}";
    </script>
    """
    html_code = html_code.replace("<head>", f"<head>\n{config_script}")

    # Render SPA Web App
    components.html(html_code, height=950, scrolling=True)
else:
    st.error("Không tìm thấy file index.html!")
