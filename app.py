import streamlit as st
import os

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
    st.components.v1.html(html_code, height=950, scrolling=True)
else:
    st.error("Không tìm thấy file index.html!")
