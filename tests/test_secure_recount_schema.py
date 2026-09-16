"""Static deployment contracts only; these do not replace the pgTAP database gate."""
from pathlib import Path
import re
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/202609160001_secure_second_count.sql"
TABLES = ("profiles", "recount_batches", "recount_tasks", "recount_task_secrets",
          "recount_serial_evidence", "recount_attempts", "recount_code_resolutions", "audit_logs")


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
        self.assertFalse(settings["auth"]["enable_anonymous_sign_ins"])

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
            self.assertNotRegex(sql, rf"grant[^;]+on (?:table )?public\.{table}\b[^;]+to (?:anon|authenticated)")

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


if __name__ == "__main__":
    unittest.main()
