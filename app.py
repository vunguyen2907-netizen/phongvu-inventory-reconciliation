import streamlit as st
import os
import json


def build_auth_parent_bridge_script() -> str:
    """Forward top-level recovery credentials to the embedded SPA iframe."""
    return """
<script id="inventory-auth-parent-bridge">
(() => {
  const hostWindow = window.parent === window ? window : window.parent;
  let targetWindow = null;
  const locationMessage = () => ({
    type: "inventory-auth-location",
    href: hostWindow.location.href,
    search: hostWindow.location.search,
    hash: hostWindow.location.hash
  });
  const forward = () => {
    if (targetWindow && typeof targetWindow.postMessage === "function") {
      targetWindow.postMessage(locationMessage(), "*");
    }
  };
  const handleMessage = event => {
    if (event.data?.type === "inventory-auth-bridge-ready") {
      targetWindow = event.source;
      forward();
    }
    if (
      event.source === targetWindow
      && event.data?.type === "inventory-auth-location-consumed"
    ) {
      const clean = new URL(hostWindow.location.href);
      clean.hash = "";
      clean.searchParams.delete("code");
      clean.searchParams.delete("type");
      clean.searchParams.delete("auth_recovery");
      hostWindow.history.replaceState({}, hostWindow.document.title, clean.toString());
    }
  };
  hostWindow.addEventListener("message", handleMessage);
  hostWindow.addEventListener("hashchange", forward);
  hostWindow.addEventListener("popstate", forward);
  window.addEventListener("unload", () => {
    hostWindow.removeEventListener("message", handleMessage);
    hostWindow.removeEventListener("hashchange", forward);
    hostWindow.removeEventListener("popstate", forward);
  });
})();
</script>
"""


def build_embedded_html(
    html_code: str,
    domain_code: str,
    public_url: str,
    public_key: str,
    auth_redirect_url: str = "",
) -> str:
    public_config = (
        "<script>"
        f"window.SUPABASE_URL={json.dumps(public_url)};"
        f"window.SUPABASE_KEY={json.dumps(public_key)};"
        f"window.AUTH_REDIRECT_URL={json.dumps(auth_redirect_url)};"
        "</script>"
    )
    html_code = html_code.replace("</head>", f"{public_config}</head>", 1)
    escaped_domain_code = domain_code.replace("</script", "<\\/script")
    domain_script = f"<script>{escaped_domain_code}</script>"
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
st.components.v1.html(
    build_auth_parent_bridge_script(),
    height=0,
    scrolling=False,
)

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
    auth_redirect_url = (
        st.secrets.get("AUTH_REDIRECT_URL", "")
        or os.getenv("AUTH_REDIRECT_URL", "")
    )
    domain_path = os.path.join(os.path.dirname(__file__), "recount_domain.js")
    with open(domain_path, "r", encoding="utf-8") as domain_file:
        domain_code = domain_file.read()
    html_code = build_embedded_html(
        html_code,
        domain_code,
        public_url,
        public_key,
        auth_redirect_url,
    )
    st.components.v1.html(html_code, height=950, scrolling=True)
else:
    st.error("Không tìm thấy file index.html!")
