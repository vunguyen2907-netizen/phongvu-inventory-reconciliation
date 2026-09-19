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
      window.tailwind = {{ config: {{}} }};
      window.ENABLE_LEGACY_ANONYMOUS = {str(legacy).lower()};
      window.__AUTH_FIXTURE__ = {json.dumps(fixture)};
      window.__AUTH_CALLS__ = [];
      window.__UNEXPECTED_CALLS__ = [];
      window.__PROFILE_READ_DURING_AUTH_CALLBACK__ = false;
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
            if (fixture.behavior.getSessionDeferred) {{
              const sessionAtRequest = fixture.session;
              return await new Promise(resolve => {{
                window.__RESOLVE_SESSION__ = () => {{
                  resolve({{ data: {{ session: sessionAtRequest }}, error: null }});
                  setTimeout(() => {{ window.__GET_SESSION_SETTLED__ = true; }}, 0);
                }};
              }});
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
          setSession: async (payload) => {{
            record("setSession", payload);
            fixture.session = fixture.behavior.recoverySession || {{
              user: {{ id: "recovery-user", email: "recovery@example.com" }}
            }};
            for (const callback of authListeners) await callback("SIGNED_IN", fixture.session);
            return {{ data: {{ session: fixture.session }}, error: null }};
          }},
          exchangeCodeForSession: async (code) => {{
            record("exchangeCodeForSession", {{ code }});
            fixture.session = fixture.behavior.recoverySession || {{
              user: {{ id: "recovery-user", email: "recovery@example.com" }}
            }};
            for (const callback of authListeners) await callback("SIGNED_IN", fixture.session);
            return {{ data: {{ session: fixture.session }}, error: null }};
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
          if (table === "profiles" && window.__IN_AUTH_CALLBACK__) {{
            window.__PROFILE_READ_DURING_AUTH_CALLBACK__ = true;
          }}
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
                : table === "profiles"
                  ? (fixture.behavior.accountProfiles || [])
                  : [{{ id: "archive-1", year_month: "2026-09", session_name: "Saved archive", updated_at: "2026-09-16T00:00:00Z" }}],
              error: null
            }}),
            maybeSingle: async () => {{
              if (fixture.behavior.profileDeferred) {{
                return await new Promise(resolve => {{
                  window.__RESOLVE_PROFILE__ = () => resolve({{ data: fixture.profile, error: null }});
                }});
              }}
              if ((fixture.behavior.profileFailures || 0) > 0) {{
                fixture.behavior.profileFailures -= 1;
                throw new Error("profile network unavailable");
              }}
              return {{ data: fixture.profile, error: null }};
            }},
            single: async () => ({{ data: fixture.profile, error: null }})
          }};
          return query;
        }},
        rpc: async (name, payload) => {{
          record("rpc", {{ name, payload }});
          return {{ data: {{}}, error: null }};
        }},
        functions: {{
          invoke: async (name, options) => {{
            record("function.invoke", {{ name, body: options?.body }});
            if (fixture.behavior.functionInvokeError) {{
              return {{ data: null, error: {{ message: fixture.behavior.functionInvokeError }} }};
            }}
            return {{ data: {{ ok: true }}, error: null }};
          }}
        }}
      }};
      window.__TRIGGER_AUTH__ = async (event, nextSession = fixture.session) => {{
        fixture.session = nextSession;
        for (const callback of authListeners) await callback(event, nextSession);
      }};
      window.__EMIT_AUTH_SYNC__ = (event, nextSession = fixture.session) => {{
        fixture.session = nextSession;
        window.__IN_AUTH_CALLBACK__ = true;
        try {{
          return authListeners.map(callback => {{
            const result = callback(event, nextSession);
            return Boolean(result && typeof result.then === "function");
          }});
        }} finally {{
          window.__IN_AUTH_CALLBACK__ = false;
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

    def setUp(self):
        self.pages = []
        self.browser_errors = []

    def tearDown(self):
        failures = list(self.browser_errors)
        for page in self.pages:
            if page.is_closed():
                failures.append("test closed a page before backend-call inspection")
                continue
            for frame in page.frames:
                try:
                    unexpected = frame.evaluate("window.__UNEXPECTED_CALLS__ || []")
                    failures.extend(
                        f"{frame.url}: {item}" for item in unexpected
                    )
                except Exception as error:
                    if not frame.is_detached():
                        failures.append(
                            f"could not inspect browser calls in {frame.url}: {error}"
                        )
            page.close()
        if failures:
            self.fail("Browser/backend errors:\n" + "\n".join(failures))

    def track_page(self, page):
        self.pages.append(page)
        page.on("pageerror", lambda error: self.browser_errors.append(f"pageerror: {error}"))
        page.on(
            "console",
            lambda message: self.browser_errors.append(f"console error: {message.text}")
            if message.type == "error"
            else None,
        )
        return page

    def open_auth_page(self, session=None, profile=None, legacy=False, behavior=None):
        page = self.track_page(self.browser.new_page())
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
            route.fulfill(status=200, content_type="text/plain", body="")

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

    def test_manager_account_panel_approves_with_an_edited_erp_alias(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {"id": "manager-user", "email": "manager@example.com", "full_name": "Manager User", "erp_name": "ERP Manager", "role": "manager", "status": "active"}
        pending = {"id": "pending-user", "email": "pending@example.com", "full_name": "Pending User", "erp_name": "Old ERP", "role": "counter", "status": "pending"}
        page = self.open_auth_page(session, profile, behavior={"accountProfiles": [pending]})

        page.get_by_role("button", name="Quản lý tài khoản").click()
        page.get_by_role("heading", name="Quản lý tài khoản").wait_for()
        alias = page.get_by_label("ERP cho Pending User")
        alias.fill("ERP NEW")
        page.get_by_role("button", name="Phê duyệt Pending User").click()

        call = page.evaluate("window.__AUTH_CALLS__.find(call => call.method === 'function.invoke')")
        self.assertEqual(call["payload"], {"name": "admin-user-lifecycle", "body": {"action": "approve_user", "target_user_id": "pending-user", "erp_name": "ERP NEW"}})

    def test_manager_account_panel_can_delete_a_pending_registration_with_typed_confirmation(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {"id": "manager-user", "email": "manager@example.com", "full_name": "Manager User", "erp_name": "ERP Manager", "role": "manager", "status": "active"}
        pending = {"id": "pending-user", "email": "pending@example.com", "full_name": "Pending User", "erp_name": "Old ERP", "role": "counter", "status": "pending"}
        page = self.open_auth_page(session, profile, behavior={"accountProfiles": [pending]})
        page.get_by_role("button", name="Quản lý tài khoản").click()

        page.get_by_role("button", name="Xóa Pending User").click()
        page.get_by_label("Nhập email để xác nhận").fill("pending@example.com")
        page.get_by_role("button", name="Xác nhận xóa").click()
        call = page.evaluate("window.__AUTH_CALLS__.find(call => call.method === 'function.invoke')")
        self.assertEqual(call["payload"]["body"], {"action": "delete_user", "target_user_id": "pending-user"})

    def test_manager_account_panel_keeps_typed_delete_confirmation_after_failure(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {"id": "manager-user", "email": "manager@example.com", "full_name": "Manager User", "erp_name": "ERP Manager", "role": "manager", "status": "active"}
        active = {"id": "active-user", "email": "active@example.com", "full_name": "Active User", "erp_name": "ERP Active", "role": "counter", "status": "active"}
        page = self.open_auth_page(
            session,
            profile,
            behavior={"accountProfiles": [active], "functionInvokeError": "lifecycle unavailable"},
        )
        page.get_by_role("button", name="Quản lý tài khoản").click()
        page.get_by_role("button", name="Hoạt động", exact=True).click()
        page.get_by_role("button", name="Xóa Active User").click()
        confirmation = page.get_by_label("Nhập email để xác nhận")
        confirmation.fill("active@example.com")
        page.get_by_role("button", name="Xác nhận xóa").click()

        page.get_by_role("alert").wait_for()
        self.assertIn("lifecycle unavailable", page.get_by_role("alert").inner_text())
        self.assertEqual(confirmation.input_value(), "active@example.com")
        self.assertTrue(page.get_by_role("heading", name="Xóa quyền đăng nhập").is_visible())

    def test_manager_account_panel_locks_unlocks_and_requires_typed_delete_confirmation(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {"id": "manager-user", "email": "manager@example.com", "full_name": "Manager User", "erp_name": "ERP Manager", "role": "manager", "status": "active"}
        accounts = [
            {"id": "active-user", "email": "active@example.com", "full_name": "Active User", "erp_name": "ERP Active", "role": "counter", "status": "active"},
            {"id": "locked-user", "email": "locked@example.com", "full_name": "Locked User", "erp_name": "ERP Locked", "role": "counter", "status": "locked"},
            {"id": "deleted-user", "email": "deleted@example.com", "full_name": "Deleted User", "erp_name": "ERP Deleted", "role": "counter", "status": "deleted"},
        ]
        page = self.open_auth_page(session, profile, behavior={"accountProfiles": accounts})
        page.get_by_role("button", name="Quản lý tài khoản").click()

        page.get_by_role("button", name="Hoạt động", exact=True).click()
        page.get_by_role("button", name="Khóa Active User").click()
        page.get_by_label("Lý do khóa").fill("Nghỉ việc")
        page.get_by_role("button", name="Xác nhận khóa").click()
        page.get_by_role("button", name="Xóa Active User").click()
        confirm = page.get_by_role("button", name="Xác nhận xóa")
        self.assertTrue(confirm.is_disabled())
        page.get_by_label("Nhập email để xác nhận").fill("active@example.com")
        confirm.click()

        page.get_by_role("button", name="Đã khóa", exact=True).click()
        page.get_by_role("button", name="Mở khóa Locked User").click()
        calls = page.evaluate("window.__AUTH_CALLS__.filter(call => ['rpc', 'function.invoke'].includes(call.method))")
        self.assertEqual(calls[0]["payload"]["name"], "manager_lock_profile")
        self.assertEqual(calls[1]["payload"]["body"], {"action": "delete_user", "target_user_id": "active-user"})
        self.assertEqual(calls[2]["payload"]["body"], {"action": "unlock_user", "target_user_id": "locked-user"})

    def test_auth_legacy_shell_requires_explicit_migration_flag(self):
        without_flag = self.open_auth_page()
        self.assertEqual(without_flag.get_by_role("navigation").count(), 0)
        self.assertNotIn(
            "signInAnonymously",
            [call["method"] for call in without_flag.evaluate("window.__AUTH_CALLS__")],
        )
        self.assertEqual(without_flag.evaluate("window.__UNEXPECTED_CALLS__"), [])

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
                "options": {"redirectTo": "https://inventory.example.com/auth?auth_recovery=1"},
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

    def test_auth_delayed_profile_cannot_restore_shell_after_sign_out(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {
            "id": "manager-user",
            "email": "manager@example.com",
            "full_name": "Manager User",
            "erp_name": "ERP Manager",
            "role": "manager",
            "status": "active",
        }
        page = self.open_auth_page(session, profile, behavior={"profileDeferred": True})
        page.wait_for_function("window.__RESOLVE_PROFILE__ !== undefined")
        page.evaluate("window.__TRIGGER_AUTH__('SIGNED_OUT', null)")
        page.evaluate("window.__RESOLVE_PROFILE__()")

        page.get_by_role("heading", name="Đăng nhập").wait_for()
        self.assertEqual(page.get_by_role("navigation").count(), 0)

    def test_auth_event_callback_returns_before_signed_in_profile_load(self):
        session = {"user": {"id": "manager-user", "email": "manager@example.com"}}
        profile = {
            "id": "manager-user",
            "email": "manager@example.com",
            "full_name": "Manager User",
            "erp_name": "ERP Manager",
            "role": "manager",
            "status": "active",
        }
        page = self.open_auth_page(None, profile, behavior={"profileDeferred": True})
        page.get_by_role("heading", name="Đăng nhập").wait_for()

        returned_promises = page.evaluate(
            "session => window.__EMIT_AUTH_SYNC__('SIGNED_IN', session)", session
        )

        self.assertEqual(returned_promises, [False])
        self.assertFalse(page.evaluate("window.__PROFILE_READ_DURING_AUTH_CALLBACK__"))
        page.wait_for_function("window.__RESOLVE_PROFILE__ !== undefined")
        page.evaluate("window.__RESOLVE_PROFILE__()")
        page.get_by_role("navigation").wait_for()

    def test_auth_stale_get_session_result_cannot_override_signed_out_event(self):
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
            behavior={"getSessionDeferred": True},
        )
        page.wait_for_function("window.__RESOLVE_SESSION__ !== undefined")
        page.evaluate("window.__TRIGGER_AUTH__('SIGNED_OUT', null)")
        page.get_by_role("heading", name="Đăng nhập").wait_for()

        page.evaluate("window.__RESOLVE_SESSION__()")
        page.wait_for_function("window.__GET_SESSION_SETTLED__ === true")

        self.assertTrue(page.get_by_role("heading", name="Đăng nhập").is_visible())
        self.assertEqual(page.get_by_role("navigation").count(), 0)
        self.assertEqual(
            page.evaluate(
                "window.__AUTH_CALLS__.filter(call => call.method === 'from' && call.payload.table === 'profiles').length"
            ),
            0,
        )

    def test_auth_missing_profile_shows_sign_out_and_retry_without_shell(self):
        session = {"user": {"id": "orphan-user", "email": "orphan@example.com"}}
        page = self.open_auth_page(session, profile=None)

        page.get_by_role("heading", name="Không tìm thấy hồ sơ tài khoản").wait_for()
        self.assertEqual(page.get_by_role("button", name="Đăng xuất").count(), 1)
        self.assertEqual(page.get_by_role("button", name="Thử lại").count(), 1)
        self.assertEqual(page.get_by_role("navigation").count(), 0)

    def test_auth_parent_recovery_bridge_opens_update_password(self):
        recovery_session = {
            "user": {"id": "recovery-user", "email": "recovery@example.com"}
        }
        page = self.track_page(self.browser.new_page())
        page.set_default_timeout(7000)
        page.add_init_script(
            _mock_supabase_script(
                None,
                None,
                behavior={
                    "authRedirectUrl": "https://inventory.example.com/auth",
                    "recoverySession": recovery_session,
                },
            )
        )
        index_html = (ROOT / "index.html").read_text(encoding="utf-8")
        parent_html = """
          <!doctype html><html><body>
            <iframe id="inventory-app" src="https://inventory.example.com/app"></iframe>
            <script>
              const forward = () => {
                const frame = document.getElementById("inventory-app");
                frame.contentWindow.postMessage({
                  type: "inventory-auth-location",
                  href: window.location.href,
                  search: window.location.search,
                  hash: window.location.hash
                }, "*");
              };
              window.addEventListener("message", event => {
                if (event.data?.type === "inventory-auth-bridge-ready") forward();
              });
              document.getElementById("inventory-app").addEventListener("load", forward);
            </script>
          </body></html>
        """

        def route_recovery(route):
            url = route.request.url
            if url.startswith("https://inventory.example.com/auth"):
                route.fulfill(status=200, content_type="text/html", body=parent_html)
            elif url == "https://inventory.example.com/app":
                route.fulfill(status=200, content_type="text/html", body=index_html)
            else:
                self._route_asset(route)

        page.route("**/*", route_recovery)
        page.goto(
            "https://inventory.example.com/auth?auth_recovery=1"
            "#access_token=recovery-access&refresh_token=recovery-refresh&type=recovery",
            wait_until="domcontentloaded",
        )
        app = page.frame_locator("#inventory-app")
        app.get_by_role("heading", name="Đặt mật khẩu mới").wait_for()
        app.get_by_label("Mật khẩu mới", exact=True).fill("new-safe-password")
        app.get_by_label("Nhập lại mật khẩu mới").fill("new-safe-password")
        app.get_by_role("button", name="Cập nhật mật khẩu").click()

        call = page.frames[1].evaluate(
            "window.__AUTH_CALLS__.find(call => call.method === 'updateUser')"
        )
        self.assertEqual(call["payload"], {"password": "new-safe-password"})


class RecountUiContractTest(unittest.TestCase):
    def test_password_recovery_redirect_falls_back_when_configured_url_is_invalid(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn('new URL(getAuthRedirectUrl(), safeOrigin)', html)
        self.assertIn('new URL(window.location.pathname || "/", safeOrigin)', html)
        self.assertIn('url.searchParams.set("auth_recovery", "1")', html)

    def test_counter_loads_only_assigned_masked_recount_tasks(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("fetchCounterRecountTasks", html)
        self.assertIn("counter_list_recount_tasks", html)
        self.assertIn("masked_reference", html)
        self.assertIn("Chưa có task kiểm lần 2 được phân công cho tài khoản này.", html)

    def test_counter_can_scan_and_confirm_each_assigned_task(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("counterScanValues", html)
        self.assertIn("counter_submit_recount_attempt", html)
        self.assertIn("Serial bổ sung", html)
        self.assertIn("Kiểm đếm xong", html)

    def test_create_recount_batch_exposes_loading_state_and_blocks_repeat_clicks(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("Đang tạo danh sách kiểm lần 2", html)
        self.assertIn("disabled={recountLoading}", html)
        self.assertIn('aria-busy={recountLoading}', html)

    def test_reopen_action_has_confirmation_modal_and_only_completed_tasks_are_enabled(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("recountReopenTarget &&", html)
        self.assertIn("disabled={task.state !== \"completed\" || recountLoading}", html)
        self.assertIn("Nhập MO LAI để xác nhận", html)

    def test_manager_recount_workspace_supports_refreshable_assignments_and_select_all(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("Chọn tất cả task trên trang", html)
        self.assertIn("Đã nhận", html)
        self.assertIn("fetchRecountCounters();", html)
        self.assertNotIn("Danh sách kiểm lần 2 an toàn", html)
        self.assertNotIn("Tạo snapshot chênh lệch", html)

    def test_account_actions_are_grouped_with_profile_and_password_reset_has_feedback(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("Quản lý tài khoản", html)
        self.assertIn("Đang gửi email đổi mật khẩu…", html)
        self.assertIn("Đã gửi email đổi mật khẩu", html)

    def test_registration_fields_are_ordered_and_autocomplete_safe(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertLess(html.index('id="auth-full-name"'), html.index('id="auth-password"'))
        self.assertIn('id="auth-full-name" name="full_name" required autoComplete="name"', html)
        self.assertIn('id="auth-erp-name" name="erp_name" required autoComplete="organization-title"', html)
        self.assertIn('id="auth-password" name="password" type="password" required minLength="6"', html)
        self.assertIn('autoComplete={isSignUp ? "new-password" : "current-password"}', html)
        self.assertIn("Mật khẩu chỉ dùng đăng nhập, không lưu vào hồ sơ nhân sự.", html)

    def test_counter_refresh_button_exposes_loading_feedback(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("recountCountersLoading", html)
        self.assertIn("⏳ Đang tải nhân sự…", html)

    def test_manager_recount_results_reload_for_the_selected_inventory_session(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn("manager_get_latest_recount_batch", html)
        self.assertIn("p_inventory_session_id: sessionId || null", html)
        self.assertIn("setRecountBatch(null);", html)
        self.assertIn("loadLatestRecountBatch(activeSessionId);", html)


if __name__ == "__main__":
    unittest.main()
