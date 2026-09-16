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


def _mock_supabase_script(session, profile, legacy=False, behavior=None):
    fixture = {
        "session": session,
        "profile": profile,
        "legacy": legacy,
        "behavior": behavior or {},
    }
    return f"""
      window.SUPABASE_URL = "https://example.supabase.co";
      window.SUPABASE_KEY = "publishable-test-key";
      window.ENABLE_LEGACY_ANONYMOUS = {str(legacy).lower()};
      window.__AUTH_FIXTURE__ = {json.dumps(fixture)};
      window.__AUTH_CALLS__ = [];
      window.__UNEXPECTED_CALLS__ = [];
      if (window.__AUTH_FIXTURE__.behavior.authRedirectUrl) {{
        window.AUTH_REDIRECT_URL = window.__AUTH_FIXTURE__.behavior.authRedirectUrl;
      }}

      const fixture = window.__AUTH_FIXTURE__;
      const authListeners = [];
      const record = (method, payload = undefined) => {{
        const call = {{ method }};
        if (payload !== undefined) call.payload = payload;
        window.__AUTH_CALLS__.push(call);
      }};
      const client = {{
        auth: {{
          getSession: async () => {{
            record("getSession");
            if ((fixture.behavior.getSessionFailures || 0) > 0) {{
              fixture.behavior.getSessionFailures -= 1;
              throw new Error("session network unavailable");
            }}
            return {{ data: {{ session: fixture.session }}, error: null }};
          }},
          onAuthStateChange: (callback) => {{
            record("onAuthStateChange");
            authListeners.push(callback);
            return {{ data: {{ subscription: {{ unsubscribe() {{}} }} }} }};
          }},
          signInWithPassword: async (payload) => {{
            record("signInWithPassword", payload);
            return {{ data: {{}}, error: null }};
          }},
          signUp: async (payload) => {{
            record("signUp", payload);
            return {{ data: {{ user: {{ id: "new-user" }}, session: null }}, error: null }};
          }},
          signInAnonymously: async () => {{
            record("signInAnonymously");
            if (fixture.behavior.signInAnonymousError) {{
              return {{ data: {{ session: null }}, error: {{ message: fixture.behavior.signInAnonymousError }} }};
            }}
            fixture.session = fixture.behavior.anonymousSession || {{
              user: {{ id: "legacy-anonymous", email: null, is_anonymous: true }}
            }};
            return {{ data: {{ session: fixture.session }}, error: null }};
          }},
          signOut: async () => {{
            record("signOut");
            if (fixture.behavior.signOutError) {{
              return {{ error: {{ message: fixture.behavior.signOutError }} }};
            }}
            fixture.session = null;
            for (const callback of authListeners) callback("SIGNED_OUT", null);
            return {{ error: null }};
          }},
          resetPasswordForEmail: async (email, options) => {{
            record("resetPasswordForEmail", {{ email, options }});
            return {{ data: {{}}, error: null }};
          }},
          updateUser: async (payload) => {{
            record("updateUser", payload);
            if (fixture.behavior.updateUserError) {{
              return {{ data: null, error: {{ message: fixture.behavior.updateUserError }} }};
            }}
            return {{ data: {{ user: fixture.session?.user }}, error: null }};
          }}
        }},
        from: (table) => {{
          record("from", {{ table }});
          if (!["profiles", "inventory_sessions", "monthly_archives"].includes(table)) {{
            window.__UNEXPECTED_CALLS__.push(`Unexpected table: ${{table}}`);
            throw new Error(`Unexpected table: ${{table}}`);
          }}
          const query = {{
            select() {{ return query; }},
            eq(column, value) {{
              if (table === "profiles" && (column !== "id" || value !== fixture.session?.user?.id)) {{
                throw new Error("Profile query must use the authenticated user id");
              }}
              return query;
            }},
            order: async () => ({{
              data: table === "inventory_sessions"
                ? [{{ id: "saved-1", session_name: "Saved session", updated_at: "2026-09-16T00:00:00Z" }}]
                : [{{ id: "archive-1", year_month: "2026-09", session_name: "Saved archive", updated_at: "2026-09-16T00:00:00Z" }}],
              error: null
            }}),
            maybeSingle: async () => {{
              if ((fixture.behavior.profileFailures || 0) > 0) {{
                fixture.behavior.profileFailures -= 1;
                throw new Error("profile network unavailable");
              }}
              return {{ data: fixture.profile, error: null }};
            }},
            single: async () => ({{ data: fixture.profile, error: null }})
          }};
          return query;
        }}
      }};
      window.__TRIGGER_AUTH__ = async (event, nextSession = fixture.session) => {{
        fixture.session = nextSession;
        for (const callback of authListeners) await callback(event, nextSession);
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

    def open_auth_page(self, session=None, profile=None, legacy=False, behavior=None):
        page = self.browser.new_page()
        self.addCleanup(page.close)
        page.set_default_timeout(7000)
        page.add_init_script(_mock_supabase_script(session, profile, legacy, behavior))
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
        self.assertNotIn(
            "signInAnonymously",
            [call["method"] for call in without_flag.evaluate("window.__AUTH_CALLS__")],
        )
        self.assertEqual(without_flag.evaluate("window.__UNEXPECTED_CALLS__"), [])
        without_flag.close()

        with_flag = self.open_auth_page(legacy=True)
        tabs = with_flag.get_by_role("navigation").get_by_role("button").all_inner_texts()
        self.assertEqual(tabs, MANAGER_TABS)

    def test_auth_flagged_legacy_mode_authenticates_before_saved_session_reads(self):
        page = self.open_auth_page(legacy=True)
        page.get_by_role("navigation").wait_for()

        calls = page.evaluate("window.__AUTH_CALLS__")
        methods = [call["method"] for call in calls]
        self.assertIn("signInAnonymously", methods)
        anonymous_index = methods.index("signInAnonymously")
        saved_read_index = next(
            index
            for index, call in enumerate(calls)
            if call["method"] == "from" and call["payload"]["table"] == "inventory_sessions"
        )
        self.assertLess(anonymous_index, saved_read_index)
        self.assertEqual(page.evaluate("window.__UNEXPECTED_CALLS__"), [])

    def test_auth_flagged_legacy_mode_reuses_preexisting_anonymous_session(self):
        anonymous_session = {
            "user": {"id": "existing-anonymous", "email": None, "is_anonymous": True}
        }
        page = self.open_auth_page(session=anonymous_session, legacy=True)
        page.get_by_role("navigation").wait_for()

        calls = page.evaluate("window.__AUTH_CALLS__")
        self.assertNotIn("signInAnonymously", [call["method"] for call in calls])
        self.assertTrue(
            any(
                call["method"] == "from" and call["payload"]["table"] == "inventory_sessions"
                for call in calls
            )
        )
        self.assertEqual(page.evaluate("window.__UNEXPECTED_CALLS__"), [])

    def test_auth_session_network_error_renders_retry_and_recovers(self):
        page = self.open_auth_page(behavior={"getSessionFailures": 1})
        page.get_by_role("heading", name="Không thể xác thực").wait_for()
        self.assertIn("session network unavailable", page.get_by_role("alert").inner_text())

        page.get_by_role("button", name="Thử lại").click()
        page.get_by_role("heading", name="Đăng nhập").wait_for()

    def test_auth_profile_network_error_renders_retry_and_recovers(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {
            "id": "manager-user",
            "email": "manager@example.com",
            "full_name": "Manager User",
            "erp_name": "ERP Manager",
            "role": "manager",
            "status": "active",
        }
        page = self.open_auth_page(session, profile, behavior={"profileFailures": 1})
        page.get_by_role("heading", name="Không thể xác thực").wait_for()
        self.assertIn("profile network unavailable", page.get_by_role("alert").inner_text())

        page.get_by_role("button", name="Thử lại").click()
        page.get_by_role("navigation").wait_for()
        self.assertEqual(page.get_by_role("navigation").get_by_role("button").all_inner_texts(), MANAGER_TABS)

    def test_auth_sign_out_failure_is_visible(self):
        session = {"user": {"id": "pending-user", "email": "pending@example.com"}}
        profile = {
            "id": "pending-user",
            "email": "pending@example.com",
            "full_name": "Pending User",
            "erp_name": "ERP Pending",
            "role": "counter",
            "status": "pending",
        }
        page = self.open_auth_page(session, profile, behavior={"signOutError": "sign out unavailable"})
        page.get_by_role("button", name="Đăng xuất").click()

        page.get_by_role("alert").wait_for()
        self.assertIn("sign out unavailable", page.get_by_role("alert").inner_text())

    def test_auth_manager_sign_out_failure_is_visible(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {
            "id": "manager-user",
            "email": "manager@example.com",
            "full_name": "Manager User",
            "erp_name": "ERP Manager",
            "role": "manager",
            "status": "active",
        }
        page = self.open_auth_page(session, profile, behavior={"signOutError": "sign out unavailable"})
        page.get_by_role("button", name="Đăng xuất").click()

        page.get_by_role("alert").wait_for()
        self.assertIn("sign out unavailable", page.get_by_role("alert").inner_text())

    def test_auth_password_reset_uses_configured_top_level_redirect(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {
            "id": "manager-user",
            "email": "manager@example.com",
            "full_name": "Manager User",
            "erp_name": "ERP Manager",
            "role": "manager",
            "status": "active",
        }
        page = self.open_auth_page(
            session,
            profile,
            behavior={"authRedirectUrl": "https://inventory.example.com/auth"},
        )
        page.get_by_role("button", name="Gửi email đổi mật khẩu").click()

        call = page.evaluate("window.__AUTH_CALLS__.find(call => call.method === 'resetPasswordForEmail')")
        self.assertEqual(
            call["payload"],
            {
                "email": "manager@example.com",
                "options": {"redirectTo": "https://inventory.example.com/auth"},
            },
        )

    def test_auth_password_recovery_event_updates_password(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {
            "id": "manager-user",
            "email": "manager@example.com",
            "full_name": "Manager User",
            "erp_name": "ERP Manager",
            "role": "manager",
            "status": "active",
        }
        page = self.open_auth_page(session, profile)
        page.get_by_role("navigation").wait_for()
        page.evaluate("window.__TRIGGER_AUTH__('PASSWORD_RECOVERY')")
        page.get_by_role("heading", name="Đặt mật khẩu mới").wait_for()
        page.get_by_label("Mật khẩu mới", exact=True).fill("new-safe-password")
        page.get_by_label("Nhập lại mật khẩu mới").fill("new-safe-password")
        page.get_by_role("button", name="Cập nhật mật khẩu").click()

        page.get_by_role("navigation").wait_for()
        call = page.evaluate("window.__AUTH_CALLS__.find(call => call.method === 'updateUser')")
        self.assertEqual(call["payload"], {"password": "new-safe-password"})


if __name__ == "__main__":
    unittest.main()
