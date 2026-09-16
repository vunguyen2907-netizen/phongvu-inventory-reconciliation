import json
import unittest
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ModuleNotFoundError:  # The core Python suite can run without browser extras.
    sync_playwright = None


ROOT = Path(__file__).resolve().parents[1]
INDEX_URL = (ROOT / "index.html").as_uri()

MANAGER_TABS = [
    "1. Nhập dữ liệu",
    "2. Chi tiết Serial",
    "3. Kiểm đếm lần 2",
    "4. Báo cáo kiểm lần 2",
    "5. Bảng tổng hợp chênh lệch",
    "6. Xuất báo cáo",
    "7. Lưu trữ hàng tháng",
]


def _mock_supabase_script(session, profile, legacy=False):
    fixture = {"session": session, "profile": profile, "legacy": legacy}
    return f"""
      window.SUPABASE_URL = "https://example.supabase.co";
      window.SUPABASE_KEY = "publishable-test-key";
      window.ENABLE_LEGACY_ANONYMOUS = {str(legacy).lower()};
      window.__AUTH_FIXTURE__ = {json.dumps(fixture)};
      window.__AUTH_CALLS__ = [];

      const fixture = window.__AUTH_FIXTURE__;
      const authListeners = [];
      const client = {{
        auth: {{
          getSession: async () => ({{ data: {{ session: fixture.session }}, error: null }}),
          onAuthStateChange: (callback) => {{
            authListeners.push(callback);
            return {{ data: {{ subscription: {{ unsubscribe() {{}} }} }} }};
          }},
          signInWithPassword: async (payload) => {{
            window.__AUTH_CALLS__.push({{ method: "signInWithPassword", payload }});
            return {{ data: {{}}, error: null }};
          }},
          signUp: async (payload) => {{
            window.__AUTH_CALLS__.push({{ method: "signUp", payload }});
            return {{ data: {{ user: {{ id: "new-user" }}, session: null }}, error: null }};
          }},
          signOut: async () => {{
            window.__AUTH_CALLS__.push({{ method: "signOut" }});
            fixture.session = null;
            for (const callback of authListeners) callback("SIGNED_OUT", null);
            return {{ error: null }};
          }}
        }},
        from: (table) => {{
          if (table !== "profiles") throw new Error(`Unexpected table: ${{table}}`);
          const query = {{
            select() {{ return query; }},
            eq(column, value) {{
              if (column !== "id" || value !== fixture.session?.user?.id) {{
                throw new Error("Profile query must use the authenticated user id");
              }}
              return query;
            }},
            maybeSingle: async () => ({{ data: fixture.profile, error: null }}),
            single: async () => ({{ data: fixture.profile, error: null }})
          }};
          return query;
        }}
      }};
      window.supabase = {{ createClient: () => client }};
    """


class AuthUiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sync_playwright is None:
            raise unittest.SkipTest("Playwright is not installed in this Python environment")
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def open_auth_page(self, session=None, profile=None, legacy=False):
        page = self.browser.new_page()
        self.addCleanup(page.close)
        page.add_init_script(_mock_supabase_script(session, profile, legacy))
        page.route("**/*", lambda route: self._route_asset(route))
        page.goto(INDEX_URL, wait_until="domcontentloaded")
        page.locator("#root").wait_for(state="attached")
        return page

    @staticmethod
    def _route_asset(route):
        url = route.request.url
        required = (
            "react@18/umd/react.production.min.js",
            "react-dom@18/umd/react-dom.production.min.js",
            "@babel/standalone/babel.min.js",
        )
        if url.startswith("file:") or any(part in url for part in required):
            route.continue_()
        else:
            route.abort()

    def test_auth_unauthenticated_user_can_switch_between_sign_in_and_sign_up(self):
        page = self.open_auth_page()

        self.assertTrue(page.get_by_role("heading", name="Đăng nhập").is_visible())
        page.get_by_role("button", name="Tạo tài khoản").click()
        self.assertTrue(page.get_by_role("heading", name="Đăng ký tài khoản").is_visible())

    def test_auth_registration_sends_only_approved_profile_metadata(self):
        page = self.open_auth_page()
        page.get_by_role("button", name="Tạo tài khoản").click()
        page.get_by_label("Email").fill("counter@example.com")
        page.get_by_label("Mật khẩu").fill("safe-password")
        page.get_by_label("Họ và tên").fill("  Nguyễn An  ")
        page.get_by_label("Tên nhân viên ERP").fill("  ERP AN  ")
        page.get_by_role("button", name="Đăng ký", exact=True).click()

        call = page.evaluate("window.__AUTH_CALLS__.find(call => call.method === 'signUp')")
        self.assertEqual(
            call["payload"],
            {
                "email": "counter@example.com",
                "password": "safe-password",
                "options": {"data": {"full_name": "Nguyễn An", "erp_name": "ERP AN"}},
            },
        )
        self.assertNotIn("role", call["payload"]["options"]["data"])
        self.assertNotIn("status", call["payload"]["options"]["data"])

    def test_auth_pending_user_sees_only_approval_status_and_sign_out(self):
        session = {"user": {"id": "pending-user", "email": "pending@example.com"}}
        profile = {
            "id": "pending-user",
            "email": "pending@example.com",
            "full_name": "Pending User",
            "erp_name": "ERP Pending",
            "role": "counter",
            "status": "pending",
        }
        page = self.open_auth_page(session, profile)

        self.assertTrue(page.get_by_role("heading", name="Chờ phê duyệt").is_visible())
        self.assertEqual(page.get_by_role("button", name="Đăng xuất").count(), 1)
        self.assertEqual(page.get_by_role("navigation").count(), 0)

    def test_auth_locked_or_deleted_user_sees_access_disabled(self):
        for status in ("locked", "deleted"):
            with self.subTest(status=status):
                session = {"user": {"id": f"{status}-user", "email": f"{status}@example.com"}}
                profile = {
                    "id": f"{status}-user",
                    "email": f"{status}@example.com",
                    "full_name": "Disabled User",
                    "erp_name": "ERP Disabled",
                    "role": "counter",
                    "status": status,
                }
                page = self.open_auth_page(session, profile)
                self.assertTrue(page.get_by_role("heading", name="Quyền truy cập đã bị vô hiệu hóa").is_visible())
                self.assertEqual(page.get_by_role("navigation").count(), 0)
                page.close()

    def test_auth_counter_sees_only_second_count_tab(self):
        session = {"user": {"id": "counter-user", "email": "counter@example.com"}}
        profile = {
            "id": "counter-user",
            "email": "counter@example.com",
            "full_name": "Counter User",
            "erp_name": "ERP Counter",
            "role": "counter",
            "status": "active",
        }
        page = self.open_auth_page(session, profile)

        tabs = page.get_by_role("navigation").get_by_role("button").all_inner_texts()
        self.assertEqual(tabs, ["Kiểm đếm lần 2"])
        self.assertEqual(page.get_by_text("Tải lên file Tồn kho", exact=False).count(), 0)

    def test_auth_manager_and_admin_see_exactly_seven_approved_tabs(self):
        for role in ("manager", "admin"):
            with self.subTest(role=role):
                session = {"user": {"id": f"{role}-user", "email": f"{role}@example.com"}}
                profile = {
                    "id": f"{role}-user",
                    "email": f"{role}@example.com",
                    "full_name": f"{role.title()} User",
                    "erp_name": f"ERP {role.title()}",
                    "role": role,
                    "status": "active",
                }
                page = self.open_auth_page(session, profile)
                tabs = page.get_by_role("navigation").get_by_role("button").all_inner_texts()
                self.assertEqual(tabs, MANAGER_TABS)
                page.close()

    def test_auth_legacy_shell_requires_explicit_migration_flag(self):
        without_flag = self.open_auth_page()
        self.assertEqual(without_flag.get_by_role("navigation").count(), 0)
        without_flag.close()

        with_flag = self.open_auth_page(legacy=True)
        tabs = with_flag.get_by_role("navigation").get_by_role("button").all_inner_texts()
        self.assertEqual(tabs, MANAGER_TABS)


if __name__ == "__main__":
    unittest.main()
