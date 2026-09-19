"""Static deployment contracts only; these do not replace the pgTAP database gate."""
from pathlib import Path
import re
import unittest

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.9 remains supported by the application.
    tomllib = None

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/202609160001_secure_second_count.sql"
LIFECYCLE_FUNCTION = ROOT / "supabase/functions/admin-user-lifecycle/index.ts"
INDEX_HTML = ROOT / "index.html"
TABLES = ("profiles", "recount_batches", "recount_tasks", "recount_task_secrets",
          "recount_serial_evidence", "recount_attempts", "recount_code_resolutions", "audit_logs")


def protected_client_grants(sql):
    """Static warning only: database ACL checks remain authoritative."""
    sql = re.sub(r"--[^\n]*", "", sql.lower()).replace('"', '')
    unsafe = []
    for match in re.finditer(r"\bgrant\b[^;]+?\bon\s+([^;]+?)\s+to\s+([^;]+);", sql):
        targets, grantees = match.groups()
        client_role = re.search(r"\b(public|anon|authenticated)\b", grantees)
        protected_table = re.search(r"\bpublic\s*\.\s*(recount_task_secrets|recount_serial_evidence)\b", targets)
        public_schema = re.search(r"\ball\s+tables\s+in\s+schema\s+[^;]*\bpublic\b", targets)
        if client_role and (protected_table or public_schema):
            unsafe.append(match.group())
    return unsafe


class SecureRecountSchemaContractTests(unittest.TestCase):
    def migration(self):
        self.assertTrue(MIGRATION.exists(), "secure recount migration is missing")
        return MIGRATION.read_text()

    def test_local_project_uses_standard_supabase_layout(self):
        config = ROOT / "supabase/config.toml"
        self.assertTrue(config.exists(), "local Supabase config is missing")
        if tomllib is None:
            source = config.read_text()
            self.assertRegex(source, r"(?m)^major_version\s*=\s*15$")
            self.assertRegex(source, r"(?ms)^\[db\.migrations\].*?^enabled\s*=\s*true$")
            self.assertNotRegex(source, r"(?m)^schemas\s*=.*\bprivate\b")
            self.assertRegex(source, r"(?m)^enable_anonymous_sign_ins\s*=\s*true$")
            self.assertRegex(source, r"(?ms)^\[functions\.admin-user-lifecycle\].*?^verify_jwt\s*=\s*true$")
        else:
            with config.open("rb") as source:
                settings = tomllib.load(source)
            self.assertEqual(settings["db"]["major_version"], 15)
            self.assertTrue(settings["db"]["migrations"]["enabled"])
            self.assertNotIn("private", settings["api"]["schemas"])
            self.assertTrue(settings["auth"]["enable_anonymous_sign_ins"])
            self.assertTrue(settings["functions"]["admin-user-lifecycle"]["verify_jwt"])

    def test_anonymous_auth_bypasses_named_profile_creation(self):
        sql = self.migration().lower()
        body = sql.split("function private.handle_registered_user()", 1)[1].split("$$;", 1)[0]
        self.assertRegex(body, r"if new\.is_anonymous then\s+return new;\s+end if;")
        self.assertLess(body.index("if new.is_anonymous"), body.index("insert into public.profiles"))
        self.assertIn("email text not null", sql)
        self.assertIn("role public.app_role not null default 'counter'", sql)
        self.assertIn("status public.profile_status not null default 'pending'", sql)

    def test_pgtap_schema_assertions_are_unambiguous(self):
        sql = (ROOT / "supabase/tests/secure_second_count_test.sql").read_text()
        for name, count in (("has_table", 3), ("hasnt_column", 4), ("col_not_null", 4)):
            calls = re.findall(rf"\b{name}\(([^;]+)\);", sql)
            self.assertTrue(calls, name)
            for args in calls:
                self.assertEqual(len(re.findall(r"'(?:[^']|'')*'", args)), count, args)

    def test_grant_scanner_detects_grouped_and_public_grants(self):
        unsafe = (
            "grant select on public.recount_tasks, public.recount_task_secrets to authenticated;",
            "grant select on table public.profiles, public.recount_serial_evidence to service_role, anon;",
            'GRANT SELECT ON "public"."recount_task_secrets" TO PUBLIC;',
            "grant all on all tables in schema public to authenticated;",
        )
        for sql in unsafe:
            with self.subTest(sql=sql):
                self.assertTrue(protected_client_grants(sql), sql)
        self.assertFalse(protected_client_grants("grant select on public.recount_tasks to authenticated;"))
        self.assertFalse(protected_client_grants("grant select on public.recount_task_secrets to service_role;"))

    def test_all_new_tables_enable_rls(self):
        sql = self.migration().lower()
        for table in TABLES:
            with self.subTest(table=table):
                self.assertIn(f"create table public.{table} (", sql)
                self.assertIn(f"alter table public.{table} enable row level security;", sql)

    def test_protected_tables_have_no_client_grants_or_policies(self):
        sql = self.migration().lower()
        for table in ("recount_task_secrets", "recount_serial_evidence"):
            self.assertIn(f"revoke all on table public.{table} from public, anon, authenticated;", sql)
            self.assertNotRegex(sql, rf"create policy[^;]+on public\.{table}\b")
        self.assertFalse(protected_client_grants(sql))

    def test_legacy_serial_payloads_require_an_active_manager_or_admin(self):
        sql = self.migration().lower()
        self.assertNotIn("create policy inventory_sessions_authenticated_all", sql)
        self.assertNotIn("create policy monthly_archives_authenticated_all", sql)
        for table in ("inventory_sessions", "monthly_archives"):
            with self.subTest(table=table):
                self.assertIn(
                    f"revoke all on table public.{table} from public, anon, authenticated;",
                    sql,
                )
                self.assertRegex(
                    sql,
                    rf"create policy {table}_active_managers\s+on public\.{table}\s+"
                    rf"for all\s+to authenticated\s+using \(\s*\(select public\.current_profile_role\(\)\) "
                    rf"in \('admin', 'manager'\)\s*\)\s+with check \(\s*"
                    rf"\(select public\.current_profile_role\(\)\) in \('admin', 'manager'\)\s*\);",
                )

    def test_definer_functions_pin_search_path_and_revoke_public_execute(self):
        sql = self.migration().lower()
        functions = re.findall(r"create or replace function ((?:public|private)\.\w+)\((.*?)\)(.*?)\$\$;", sql, re.S)
        definers = [(name, body) for name, args, body in functions if "security definer" in body]
        self.assertGreaterEqual(len(definers), 4)
        for name, body in definers:
            self.assertIn("set search_path = ''", body, name)
            self.assertRegex(sql, rf"revoke all on function {re.escape(name)}\([^;]*\) from public, anon, authenticated;")

    def test_recount_task_state_assignments_cast_to_enum(self):
        sql = self.migration().lower()
        self.assertIn(
            "(case when v_has_assignee then 'assigned' else 'unassigned' end)::public.recount_task_state",
            sql,
        )
        self.assertIn(
            "(case when v_has_assignee and v_assignee.status = 'active' and v_assignee.role = 'counter' then 'assigned' else 'unassigned' end)::public.recount_task_state",
            sql,
        )

    def test_counter_contract_exposes_masked_list_and_assigned_only_submit_rpc(self):
        sql = self.migration().lower()
        self.assertIn("create or replace function public.counter_list_recount_tasks(", sql)
        self.assertIn("create or replace function public.counter_submit_recount_attempt(", sql)
        submit = sql.split("create or replace function public.counter_submit_recount_attempt(", 1)[1]
        self.assertIn("p_task_id uuid", submit)
        self.assertIn("p_scanned_value text", submit)
        self.assertIn("p_note text default null", submit)
        self.assertIn("t.assigned_user_id = v_actor.id", submit)
        self.assertIn("insert into public.recount_attempts", submit)
        self.assertIn("insert into public.audit_logs", submit)
        self.assertIn("public.mask_inventory_code(v_scan)", submit)
        self.assertIn("extensions.digest(v_scan, 'sha256')", submit)
        self.assertIn("grant execute on function public.counter_list_recount_tasks(uuid, public.recount_task_state) to authenticated;", sql)
        self.assertIn("grant execute on function public.counter_submit_recount_attempt(uuid, text, text) to authenticated;", sql)
        self.assertIn("create or replace function public.counter_finish_recount_session(p_batch_id uuid)", sql)
        self.assertIn("awaiting_other_counters", sql)

    def test_manager_list_qualifies_profile_id_against_returns_table_id(self):
        sql = self.migration().lower()
        self.assertIn("create or replace function public.manager_get_latest_recount_batch(", sql)
        body = sql.split("create or replace function public.manager_list_recount_tasks(", 1)[1]
        body = body.split("create or replace function public.manager_reopen_recount_tasks(", 1)[0]
        self.assertIn("from public.profiles p where p.id = (select auth.uid())", body)

    def test_account_lifecycle_rpcs_are_definer_only_and_client_allowlisted(self):
        sql = self.migration().lower()
        for name, signature in (
            ("manager_approve_profile", "uuid, text"),
            ("manager_lock_profile", "uuid, text"),
            ("manager_begin_profile_unlock", "uuid, uuid"),
            ("manager_delete_profile", "uuid"),
        ):
            with self.subTest(name=name):
                self.assertIn(f"function public.{name}", sql)
                body = sql.split(f"function public.{name}", 1)[1].split("$$;", 1)[0]
                self.assertIn("security definer", body)
                self.assertIn("set search_path = ''", body)
                self.assertIn(
                    f"revoke all on function public.{name}({signature}) from public, anon, authenticated;",
                    sql,
                )
                self.assertIn(
                    f"grant execute on function public.{name}({signature}) to authenticated;",
                    sql,
                )

        finalizer = "service_finish_profile_unlock"
        signature = "uuid, uuid, boolean"
        self.assertIn(f"function public.{finalizer}", sql)
        body = sql.split(f"function public.{finalizer}", 1)[1].split("$$;", 1)[0]
        self.assertIn("security definer", body)
        self.assertIn("set search_path = ''", body)
        self.assertIn(
            f"revoke all on function public.{finalizer}({signature}) from public, anon, authenticated;",
            sql,
        )
        self.assertIn(
            f"grant execute on function public.{finalizer}({signature}) to service_role;",
            sql,
        )
        self.assertNotIn(
            f"grant execute on function public.{finalizer}({signature}) to authenticated;",
            sql,
        )
    def test_account_lifecycle_edge_contract_preserves_the_auth_user_row(self):
        self.assertTrue(LIFECYCLE_FUNCTION.exists(), "account lifecycle Edge Function is missing")
        source = LIFECYCLE_FUNCTION.read_text()
        self.assertIn('case "delete_user"', source)
        self.assertIn('case "unlock_user"', source)
        self.assertIn("auth.getUser", source)
        self.assertIn("manager_delete_profile", source)
        self.assertIn("manager_begin_profile_unlock", source)
        self.assertIn("service_finish_profile_unlock", source)
        self.assertIn("service_release_profile_unlock", source)
        self.assertIn('ban_duration: INDEFINITE_BAN_DURATION', source)
        self.assertNotIn(".deleteUser(", source)

    def test_unlock_uses_a_locked_lease_before_auth_and_service_only_finalization(self):
        source = LIFECYCLE_FUNCTION.read_text()
        unlock = source.split('case "unlock_user":', 1)[1].split('return response(400, { error: "invalid_request" });', 1)[0]
        self.assertIn('rpc("manager_begin_profile_unlock"', source)
        self.assertIn('rpc("service_finish_profile_unlock"', source)
        begin = unlock.index("beginProfileUnlock(")
        unban = unlock.index('ban_duration: "none"')
        finish = unlock.index("finishProfileUnlock(")
        self.assertLess(begin, unban)
        self.assertLess(unban, finish)
        self.assertRegex(unlock, r'outcome\s*!==\s*"acquired"')
        self.assertIn('outcome === "already_active"', unlock)
        self.assertIn("owns_transition", unlock)
        self.assertIn("profileById(serviceClient, targetUserId)", unlock)
        self.assertNotIn('rpc("manager_lock_profile"', unlock)

        sql = self.migration().lower()
        begin_body = sql.split("function public.manager_begin_profile_unlock", 1)[1].split("$$;", 1)[0]
        self.assertIn("private.profile_unlock_operations", begin_body)
        self.assertNotRegex(begin_body, r"update public\.profiles\s+set status = 'active'")
        finish_body = sql.split("function public.service_finish_profile_unlock", 1)[1].split("$$;", 1)[0]
        self.assertRegex(finish_body, r"where operation_id = p_operation_id\s+and target_user_id = p_user_id")
        self.assertLess(finish_body.index("if p_succeeded is not true then"), finish_body.index("set status = 'active'"))
        self.assertIn("recovery_pending", finish_body)
        release_body = sql.split("function public.service_release_profile_unlock", 1)[1].split("$$;", 1)[0]
        self.assertIn("delete from private.profile_unlock_operations", release_body)

    def test_edge_rejects_null_json_and_readme_uses_supported_deploy_command(self):
        source = LIFECYCLE_FUNCTION.read_text()
        self.assertRegex(source, r"payload\s*&&\s*typeof payload === \"object\"")
        readme = (ROOT / "README.md").read_text()
        self.assertIn("supabase functions deploy admin-user-lifecycle", readme)
        self.assertNotIn("--verify-jwt", readme)

    def test_lifecycle_pgtap_fixtures_and_error_overloads_are_executable(self):
        sql = (ROOT / "supabase/tests/secure_second_count_test.sql").read_text()
        setup = "update public.recount_tasks\nset state = 'in_progress', assigned_name_snapshot = 'User 3'"
        self.assertLess(sql.index(setup), sql.index("set local role authenticated;"))
        lifecycle = sql.split("-- Account lifecycle RPCs authorize", 1)[1].split("reset role;", 1)[0]
        calls = re.findall(
            r"select throws_ok\(\s*\$\$.*?\$\$,\s*'[^']+',\s*null,\s*'[^']+'\s*\);",
            lifecycle,
            re.S,
        )
        self.assertEqual(len(calls), 5)
        inactive = sql.split("'locked manager loses legacy archive access'", 1)[1]
        self.assertRegex(
            inactive,
            r"select throws_ok\(\s*\$\$.*?\$\$,\s*'42501',\s*null,\s*'locked manager cannot call lifecycle RPCs'\s*\);",
        )

    def test_manager_account_panel_exposes_all_lifecycle_controls_without_service_credentials(self):
        source = INDEX_HTML.read_text()
        for label in ("Quản lý tài khoản", "Chờ duyệt", "Hoạt động", "Đã khóa", "Đã xóa",
                      "Lý do khóa", "Nhập email để xác nhận"):
            self.assertIn(label, source)
        self.assertIn('invokeLifecycle(client, "approve_user"', source)
        self.assertIn('rpc("manager_lock_profile"', source)
        self.assertIn('functions.invoke("admin-user-lifecycle"', source)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", source)

    def test_manager_recount_workspace_loads_the_safe_domain_and_uses_bounded_assignment_calls(self):
        """The manager queue is unusable unless its draft builder is loaded and rendered."""
        source = INDEX_HTML.read_text()
        self.assertIn('<script src="./recount_domain.js"></script>', source)
        for label in (
            "Tạo danh sách kiểm lần 2",
            "Chưa phân công",
            "Đang thực hiện",
            "Hoàn tất",
            "Phân công cho",
            "MỞ LẠI",
        ):
            with self.subTest(label=label):
                self.assertIn(label, source)
        self.assertIn("start += 500", source)
        self.assertIn("manager_bulk_assign_recount_tasks", source)
        self.assertIn("manager_reopen_recount_tasks", source)

    def test_consolidated_schema_matches_migration_and_preserves_legacy(self):
        sql = self.migration()
        consolidated = (ROOT / "supabase_schema.sql").read_text()
        marker = "-- Secure second-count subsystem (202609160001)."
        self.assertIn(marker, sql)
        self.assertEqual(consolidated.split(marker)[1], sql.split(marker)[1])
        self.assertEqual(consolidated.split(marker)[0].rstrip(), sql.split(marker)[0].rstrip())

    def test_required_indexes_and_auth_identity_contract(self):
        sql = self.migration().lower()
        for signature in ("profiles (status, role)", "profiles (erp_name_normalized)",
                          "recount_batches (inventory_session_id, status)",
                          "recount_tasks (batch_id, assigned_user_id, state)",
                          "recount_tasks (batch_id, sku)", "recount_tasks (batch_id, task_type, state)",
                          "recount_attempts (task_id, created_at desc)",
                          "audit_logs (entity_type, entity_id, created_at desc)",
                          "recount_serial_evidence (batch_id, serial_normalized)"):
            self.assertIn(signature, sql)
        self.assertIn("id uuid primary key references auth.users(id)", sql)
        self.assertIn("unique (batch_id, source_detail_row_id)", sql)
        self.assertIn("where is_excluded = false", sql)
        self.assertIn("(select auth.uid())", sql)

    def test_normalization_uses_locale_independent_ascii_casing_and_explicit_removal_set(self):
        sql = self.migration()
        body = sql.split("function public.normalize_inventory_code(p_value text)", 1)[1].split("$$;", 1)[0]
        self.assertIn("translate(", body.lower())
        self.assertNotRegex(body.lower(), r"\bupper\s*\(")
        self.assertIn("abcdefghijklmnopqrstuvwxyz", body)
        self.assertIn("ABCDEFGHIJKLMNOPQRSTUVWXYZ", body)
        for escape in (r"\0009-\000D", r"\0020", r"\0085", r"\00A0", r"\1680",
                       r"\2000-\200D", r"\2028", r"\2029", r"\202F", r"\205F",
                       r"\2060", r"\3000", r"\FEFF"):
            self.assertIn(escape, body)


if __name__ == "__main__":
    unittest.main()
