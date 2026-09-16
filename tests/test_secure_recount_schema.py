"""Static deployment contracts only; these do not replace the pgTAP database gate."""
from pathlib import Path
import re
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/202609160001_secure_second_count.sql"
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
        with config.open("rb") as source:
            settings = tomllib.load(source)
        self.assertEqual(settings["db"]["major_version"], 15)
        self.assertTrue(settings["db"]["migrations"]["enabled"])
        self.assertNotIn("private", settings["api"]["schemas"])
        self.assertTrue(settings["auth"]["enable_anonymous_sign_ins"])

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
