# Secure Second-Count Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated, role-based, serial-masked second counting for one branch while preserving the current manager reconciliation and reporting workflow.

**Architecture:** Keep existing `inventory_sessions` JSON payloads for manager workflows. Add a normalized Supabase recount subsystem containing only second-count batches, protected serial evidence, assignments, attempts, and audit records. Full serials remain server-side; browser clients receive masked references and call transactional RPCs for validation.

**Tech Stack:** Streamlit Python shell, React/Babel single-page UI, Supabase Auth, PostgreSQL/RLS/RPC, Supabase Edge Functions, Node test runner, pgTAP/Supabase CLI, Playwright for end-to-end checks.

**Spec:** `docs/superpowers/specs/2026-09-16-secure-second-count-workflow-design.md`

## Global Constraints

- Operate for one branch only; do not add `branch_id` or branch selection.
- Keep existing saved inventory sessions readable.
- Never return a complete expected serial to a `counter` browser, API response, log, or permitted query.
- A counter sees only Tab 3 and tasks assigned to `auth.uid()`.
- Default assignment follows the normalized first-count ERP performer; managers may bulk reassign.
- Custom reasons remain exactly as entered; do not add sentence prefixes.
- Only confirmed second-count results affect final totals and exports.
- A duplicate barcode/IMEI confirmation excludes the redundant source row from active totals while retaining audit history.
- Anonymous access remains available only during migration and is disabled after approved accounts pass the pilot.
- The release must pass a synthetic 20,000-serial load test.

---

## File Structure

### Create

- `recount_domain.js` — pure client-side normalization, safe formatting, task-payload, and confirmed-result merge helpers.
- `tests/test_recount_domain.mjs` — Node unit tests for the pure helpers.
- `supabase/migrations/202609160001_secure_second_count.sql` — enums, tables, indexes, triggers, RLS, and transactional RPCs.
- `supabase/config.toml` — local Supabase project configuration for migration and pgTAP execution.
- `supabase/tests/secure_second_count_test.sql` — pgTAP authorization and workflow tests.
- `supabase/functions/admin-user-lifecycle/index.ts` — authenticated account lock/delete Edge Function.
- `supabase/functions/admin-user-lifecycle/index_test.ts` — Deno authorization and lifecycle tests.
- `tests/fixtures/recount_20000.json` — generated load-test data; generated mechanically and excluded from Git if larger than 5 MB.
- `tests/generate_recount_fixture.mjs` — deterministic 20,000-row fixture generator.
- `tests/test_recount_ui.py` — Playwright role/navigation and safe-response checks.

### Modify

- `app.py` — inject `recount_domain.js` before the React application script.
- `index.html` — named Auth, role gates, account administration, manager assignment table, counter workflow, tab renumbering, and report integration.
- `supabase_schema.sql` — keep the install-from-scratch schema aligned with the migration.
- `tests/test_execution_metadata.mjs` — preserve existing first-counter extraction regressions.
- `tests/test_supabase_store.py` — preserve legacy session payload compatibility.
- `README.md` — document migration, initial admin bootstrap, SMTP, Edge Function deployment, and anonymous-auth shutdown.
- `.gitignore` — ignore generated load fixtures and Playwright output.

---

### Task 1: Establish Injection and Regression Baseline

**Files:**
- Create: `recount_domain.js`
- Create: `tests/test_recount_domain.mjs`
- Modify: `app.py`

**Interfaces:**
- Produces: `window.InventoryRecountDomain` for `index.html`.
- Preserves: current `index.html` behavior when no recount batch exists.

- [ ] **Step 1: Write a failing injection test**

Add this assertion to `tests/test_supabase_store.py` using a small helper that reads `app.py`:

```python
def test_streamlit_shell_injects_recount_domain_before_index_app():
    app_source = Path("app.py").read_text(encoding="utf-8")
    assert "recount_domain.js" in app_source
    assert "window.InventoryRecountDomain" in app_source
```

- [ ] **Step 2: Run the baseline and observe the new test fail**

Run:

```bash
python -m unittest discover -s tests -p 'test_*.py'
node tests/test_execution_metadata.mjs
```

Expected: existing tests pass and the new injection assertion fails.

- [ ] **Step 3: Add the browser-safe module shell**

Create `recount_domain.js` with this export shape:

```javascript
(function attachInventoryRecountDomain(global) {
  const api = Object.freeze({});
  global.InventoryRecountDomain = api;
})(typeof window !== "undefined" ? window : globalThis);
```

Update `app.py` to read the module, escape `</script`, and inject it before the existing `text/babel` application script:

```python
domain_path = os.path.join(os.path.dirname(__file__), "recount_domain.js")
with open(domain_path, "r", encoding="utf-8") as domain_file:
    domain_code = domain_file.read().replace("</script", "<\\/script")
domain_script = f"<script>{domain_code}</script>"
html_code = html_code.replace('<script type="text/babel">', f'{domain_script}<script type="text/babel">', 1)
```

- [ ] **Step 4: Make the injection test inspect rendered assembly rather than execute Streamlit**

Extract a pure function in `app.py`:

```python
def build_embedded_html(html_code: str, domain_code: str, public_url: str, public_key: str) -> str:
    # inject public config and recount domain, then return the complete component HTML
```

Test that `window.InventoryRecountDomain` occurs before `<script type="text/babel">`.

- [ ] **Step 5: Run tests and commit**

Run the two commands from Step 2 plus `git diff --check`.

Commit:

```bash
git add app.py recount_domain.js tests/test_supabase_store.py tests/test_recount_domain.mjs
git commit -m "refactor: add testable recount domain module"
```

---

### Task 2: Add Database Schema, Indexes, and Authorization Helpers

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/202609160001_secure_second_count.sql`
- Create: `supabase/tests/secure_second_count_test.sql`
- Modify: `supabase_schema.sql`

**Interfaces:**
- Produces enums: `app_role`, `profile_status`, `recount_batch_status`, `recount_task_type`, `recount_task_state`, `recount_resolution`, `recount_attempt_result`.
- Produces tables: `profiles`, `recount_batches`, `recount_tasks`, `recount_task_secrets`, `recount_serial_evidence`, `recount_attempts`, `recount_code_resolutions`, `audit_logs`.
- Produces helpers: `current_profile_role()`, `is_active_profile()`, `normalize_inventory_code(text)`, `mask_inventory_code(text, integer, integer)`.

- [ ] **Step 1: Initialize the local Supabase project**

Run `supabase init` and keep the generated `supabase/config.toml`. Configure the local project to run migrations from `supabase/migrations` and tests from `supabase/tests`.

- [ ] **Step 2: Write pgTAP tests for account and secret isolation**

Cover these exact assertions:

```sql
select has_table('public', 'profiles');
select has_table('public', 'recount_tasks');
select has_table('public', 'recount_task_secrets');
select has_table('public', 'recount_serial_evidence');
select row_security_active('public.recount_tasks');
select row_security_active('public.recount_task_secrets');
select throws_ok(
  $$ select expected_serial_normalized from public.recount_task_secrets $$,
  '42501'
);
```

Set JWT claims for an active counter and prove they can select only their assigned safe task row. Repeat for `pending`, `locked`, another active counter, manager, and admin.

- [ ] **Step 3: Run database tests to verify failure**

Run:

```bash
supabase db reset
supabase test db supabase/tests/secure_second_count_test.sql
```

Expected: missing-table failures.

- [ ] **Step 4: Implement enums, tables, foreign keys, and timestamps**

Use `auth.users(id)` for profile identity. Add a trigger on `auth.users` that inserts a pending counter profile from registration metadata:

```sql
insert into public.profiles (id, email, full_name, erp_name, erp_name_normalized)
values (
  new.id,
  lower(new.email),
  trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')),
  trim(coalesce(new.raw_user_meta_data ->> 'erp_name', '')),
  public.normalize_inventory_code(new.raw_user_meta_data ->> 'erp_name')
);
```

Add `recount_serial_evidence` as the protected first-count registry needed to detect already-counted and wrong-SKU scans:

```sql
create table public.recount_serial_evidence (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.recount_batches(id) on delete cascade,
  source_detail_row_id text not null,
  sku text not null,
  serial_normalized text not null,
  bin text,
  is_counted boolean not null default true,
  is_excluded boolean not null default false,
  unique (batch_id, source_detail_row_id, serial_normalized)
);
```

- [ ] **Step 5: Add indexes and RLS**

Create every index listed in the approved spec plus:

```sql
create index recount_serial_evidence_lookup_idx
  on public.recount_serial_evidence (batch_id, serial_normalized)
  where is_excluded = false;
```

Explicitly revoke all direct privileges on secret/evidence tables from `anon` and `authenticated`. Grant access only through security-definer RPCs. RLS predicates must call `(select auth.uid())` and indexed profile/task columns.

- [ ] **Step 6: Add initial-admin bootstrap procedure**

Create `private.bootstrap_initial_admin(p_user_id uuid)` with `execute` revoked from `anon` and `authenticated`. It must fail when an active admin already exists. The release operator calls it only from SQL Editor after the intended admin has registered.

- [ ] **Step 7: Mirror the migration into the consolidated schema**

Append the same objects and policy definitions to `supabase_schema.sql`, keeping legacy tables unchanged.

- [ ] **Step 8: Run database and existing tests, then commit**

Run:

```bash
supabase db reset
supabase test db supabase/tests/secure_second_count_test.sql
python -m unittest discover -s tests -p 'test_*.py'
```

Commit:

```bash
git add supabase/config.toml supabase/migrations/202609160001_secure_second_count.sql supabase/tests/secure_second_count_test.sql supabase_schema.sql
git commit -m "feat: add secure recount database model"
```

---

### Task 3: Implement and Test Serial Masking and Draft Construction

**Files:**
- Modify: `recount_domain.js`
- Modify: `tests/test_recount_domain.mjs`

**Interfaces:**
- Produces `normalizeInventoryCode(value): string`.
- Produces `maskSerialGroup(serials): Map<string,string>`.
- Produces `buildRecountDraft(detailRows, profileRows): { tasks, evidence }`.
- Produces `applyConfirmedRecounts(detailRows, resolvedTasks): detailRows`.

- [ ] **Step 1: Write failing masking tests**

Test default and middle-window behavior:

```javascript
assert.equal(maskOne("12345678AB12"), "********AB12");
assert.deepEqual(
  [...maskSerialGroup(["AAAA7X9QZZZZ", "AAAA2B4CZZZZ"]).values()],
  ["****7X9Q****", "****2B4C****"]
);
```

Also prove empty/short serials never reveal more than four characters and normalized matching ignores case, whitespace, zero-width characters, and Unicode width variants.

- [ ] **Step 2: Write failing draft-generation tests**

Use fixtures for:

- `Bắn thiếu (Chưa quét)` -> `missing_serial`
- `Bắn sai serial` -> `wrong_serial`
- `Bắn dư serial` -> `surplus_scan`
- Resolved row -> no active task
- Exact ERP alias -> assigned profile
- Missing alias -> `assigned_user_id: null`
- Duplicate active ERP alias -> validation error

- [ ] **Step 3: Run Node tests and observe failure**

Run:

```bash
node tests/test_recount_domain.mjs
```

- [ ] **Step 4: Implement minimal pure helpers**

Return payloads with stable `source_detail_row_id`, safe `masked_reference`, task type, expected secret, first-scanned secret, and evidence rows. Do not include full serials in the public task object.

- [ ] **Step 5: Test confirmed-result merging**

Cover:

```javascript
const merged = applyConfirmedRecounts(detailRows, [{
  sourceDetailRowId: "sku::7",
  resolution: "same_product_multiple_codes"
}]);
assert.equal(merged[7].excludedFromActual, true);
assert.equal(merged[7].checked, 0);
```

Also test `corrected_serial`, `not_found`, and manager-approved `genuine_surplus` without changing unconfirmed rows.

- [ ] **Step 6: Run tests and commit**

Run `node tests/test_recount_domain.mjs`, `node tests/test_execution_metadata.mjs`, and `git diff --check`.

Commit:

```bash
git add recount_domain.js tests/test_recount_domain.mjs
git commit -m "feat: add recount masking and merge rules"
```

---

### Task 4: Replace Anonymous Entry with Named Authentication and Role Gates

**Files:**
- Modify: `index.html`
- Modify: `README.md`
- Test: `tests/test_recount_ui.py`

**Interfaces:**
- Consumes `profiles` and Supabase Auth.
- Produces React auth state `{ session, profile, loading }`.
- Produces screens: sign in, sign up, pending approval, locked account, role-based application shell.

- [ ] **Step 1: Write failing UI tests**

Mock Supabase calls and assert:

- unauthenticated user sees sign-in/sign-up;
- pending user sees only approval status and sign-out;
- locked user sees access-disabled state;
- counter sees only `Kiểm đếm lần 2`;
- manager sees all seven numbered tabs.

- [ ] **Step 2: Run the UI test and verify failure**

Run:

```bash
python tests/test_recount_ui.py -k auth
```

- [ ] **Step 3: Remove automatic anonymous sign-in**

Replace `signInAnonymously()` with `getSession()` plus `onAuthStateChange()`. During the migration flag period, allow the legacy manager shell only when `window.ENABLE_LEGACY_ANONYMOUS === true`; default production behavior after rollout is named login.

- [ ] **Step 4: Add registration and login**

Registration must call:

```javascript
supabaseClient.auth.signUp({
  email,
  password,
  options: { data: { full_name: fullName.trim(), erp_name: erpName.trim() } }
});
```

Do not allow role or status in editable user metadata.

- [ ] **Step 5: Add role-derived tab definitions**

Use one manager/admin array with the approved seven labels. Use one counter array containing only `Kiểm đếm lần 2`. Reset `activeTab` safely when profile/role changes.

- [ ] **Step 6: Document SMTP and Auth settings**

Document email/password enablement, email confirmation, custom SMTP, redirect URL, and the final anonymous-auth disable switch in `README.md`.

- [ ] **Step 7: Run tests and commit**

Run UI, Node, and Python suites.

Commit:

```bash
git add index.html README.md tests/test_recount_ui.py
git commit -m "feat: add named login and role-based navigation"
```

---

### Task 5: Add Account Approval, Locking, and Deletion

**Files:**
- Create: `supabase/functions/admin-user-lifecycle/index.ts`
- Create: `supabase/functions/admin-user-lifecycle/index_test.ts`
- Modify: `index.html`
- Modify: `supabase/migrations/202609160001_secure_second_count.sql`
- Modify: `supabase/tests/secure_second_count_test.sql`
- Modify: `README.md`

**Interfaces:**
- Produces RPC `manager_approve_profile(p_user_id uuid, p_erp_name text)`.
- Produces RPC `manager_lock_profile(p_user_id uuid, p_reason text)`.
- Produces Edge Function actions `delete_user` and `unlock_user`.

- [ ] **Step 1: Add failing database tests for approval and locking**

Prove that managers can approve/lock counters, cannot promote to admin, cannot operate on an admin, and that locking unassigns incomplete tasks while preserving completed snapshots.

- [ ] **Step 2: Add failing Edge Function request tests**

Test missing JWT, counter caller, manager deleting a counter, manager attempting to delete an admin, and idempotent deletion of an already-deleted profile.

- [ ] **Step 3: Implement approval/lock RPCs**

Both functions must be `security definer`, use `set search_path = ''`, validate active caller role, normalize ERP names, reject duplicates, update open assignments atomically, and insert `audit_logs`.

- [ ] **Step 4: Implement the lifecycle Edge Function**

The function must verify the caller JWT with the publishable client, query the caller's active profile, authorize the target role, then use a service-role client only inside the Edge Function to ban/unban/delete Auth access. Database profile updates and unassignment occur through protected RPCs.

- [ ] **Step 5: Add the manager account panel**

Add a sidebar action `Quản lý tài khoản`. The panel contains pending, active, locked, and deleted filters; approval with editable ERP alias; lock with reason; unlock; and delete with typed confirmation.

- [ ] **Step 6: Deploy locally, run all tests, and commit**

Run database tests and Edge Function tests before browser tests.

Commit:

```bash
git add supabase/functions/admin-user-lifecycle index.html supabase/migrations/202609160001_secure_second_count.sql supabase/tests/secure_second_count_test.sql README.md
git commit -m "feat: manage recount user lifecycle"
```

---

### Task 6: Generate Recount Batches and Bulk Assign Tasks

**Files:**
- Modify: `supabase/migrations/202609160001_secure_second_count.sql`
- Modify: `supabase/tests/secure_second_count_test.sql`
- Modify: `index.html`
- Modify: `recount_domain.js`
- Modify: `tests/test_recount_domain.mjs`

**Interfaces:**
- Produces RPC `manager_create_recount_batch(p_inventory_session_id uuid, p_tasks jsonb, p_evidence jsonb): jsonb`.
- Produces RPC `manager_bulk_assign_recount_tasks(p_task_ids uuid[], p_user_id uuid): integer`.
- Produces RPC `manager_list_recount_tasks(...)` with pagination and safe manager columns.
- Produces RPC `manager_reopen_recount_tasks(p_task_ids uuid[], p_reason text): integer`.

- [ ] **Step 1: Write failing idempotency and assignment tests**

Create the same draft twice and prove one batch/task per `(batch_id, source_detail_row_id)`. Prove exact normalized ERP aliases assign automatically and unmatched names remain unassigned.

- [ ] **Step 2: Implement batch generation transaction**

The RPC validates manager/admin role, upserts one draft batch per inventory session, writes protected task secrets and serial evidence, computes masks server-side, and returns only batch ID and counts.

- [ ] **Step 3: Implement bulk assignment RPC**

Validate that every target task belongs to the batch and the target user is an active approved counter. Increment task version, set state, snapshot assignee name, and audit every changed row.

- [ ] **Step 4: Build manager Tab 3**

Add:

- `Tạo danh sách kiểm lần 2`
- summary cards for total/unassigned/in-progress/completed;
- paginated table;
- filters for assignee/state/type/SKU/BIN;
- current-page and current-filter selection;
- bulk assignment selector.

The UI sends task IDs in batches of at most 500 per RPC call and refreshes summary counts after each successful batch.

- [ ] **Step 5: Implement audited reopening**

`manager_reopen_recount_tasks` accepts only completed task IDs from one batch, requires a non-empty reason, resets them to assigned/unassigned based on assignee status, increments task version, and writes one audit entry per task. Add a manager action with typed confirmation and reason input.

- [ ] **Step 6: Verify no complete serial appears in manager-safe counter response fixtures**

Managers may see source reconciliation details in existing tabs, but the counter-task query contract remains masked. Add an assertion that counter-shaped records do not contain keys named `expected_serial`, `stock_serial`, or `serial_normalized`.

- [ ] **Step 7: Run tests and commit**

Commit:

```bash
git add index.html recount_domain.js tests/test_recount_domain.mjs supabase/migrations/202609160001_secure_second_count.sql supabase/tests/secure_second_count_test.sql
git commit -m "feat: generate and assign recount tasks"
```

---

### Task 7: Implement Transactional Counter Scanning and Completion

**Files:**
- Modify: `supabase/migrations/202609160001_secure_second_count.sql`
- Modify: `supabase/tests/secure_second_count_test.sql`
- Modify: `index.html`
- Modify: `tests/test_recount_ui.py`

**Interfaces:**
- Produces RPC `get_my_recount_tasks(p_batch_id uuid, p_limit integer, p_offset integer, p_search text, p_state text)`.
- Produces RPC `validate_recount_scan(p_task_id uuid, p_scanned_value text, p_idempotency_key uuid): jsonb`.
- Produces RPC `mark_recount_not_found(p_task_id uuid, p_reason text, p_idempotency_key uuid): jsonb`.
- Produces RPC `confirm_my_recount_work(p_batch_id uuid): jsonb`.

- [ ] **Step 1: Write failing RPC outcome tests**

Cover exact outcomes: `matched`, `duplicate_first_count`, `duplicate_attempt`, `wrong_sku`, `unknown_serial`, ownership denied, stale version, completed task, and idempotent retry.

- [ ] **Step 2: Implement row-locked validation**

Use `select ... for update` on the task, normalize the scan server-side, inspect protected expected serial and evidence, write one attempt, and return only:

```json
{
  "status": "matched",
  "task_id": "uuid",
  "masked_scanned": "********AB12",
  "requires_confirmation": false
}
```

- [ ] **Step 3: Implement not-found and completion RPCs**

Reject blank reasons. `confirm_my_recount_work` fails with counts when any assigned task lacks a valid ready/not-found resolution, otherwise locks the user's ready tasks and records one audit event.

- [ ] **Step 4: Build counter Tab 3**

Render the approved columns, 50/100/200 page sizes, search and filters, per-table wrap toggle, one scan input per active row, Enter submission, safe result badges, not-found reason dialog, and `Kiểm đếm xong` summary confirmation.

- [ ] **Step 5: Handle network and reassignment errors**

Keep unsent input visible. Retry with the same idempotency key. On ownership/version conflict, remove the input from submission state, show a refresh message, and reload the task page.

- [ ] **Step 6: Run RPC concurrency tests and UI tests, then commit**

Commit:

```bash
git add index.html tests/test_recount_ui.py supabase/migrations/202609160001_secure_second_count.sql supabase/tests/secure_second_count_test.sql
git commit -m "feat: add secure counter scanning workflow"
```

---

### Task 8: Resolve Duplicate Barcode/IMEI and Genuine Surplus

**Files:**
- Modify: `supabase/migrations/202609160001_secure_second_count.sql`
- Modify: `supabase/tests/secure_second_count_test.sql`
- Modify: `index.html`
- Modify: `recount_domain.js`
- Modify: `tests/test_recount_domain.mjs`

**Interfaces:**
- Produces RPC `confirm_same_product_codes(p_task_id uuid, p_idempotency_key uuid): jsonb`.
- Produces RPC `submit_genuine_surplus(p_task_id uuid, p_reason text): jsonb`.
- Produces RPC `manager_review_genuine_surplus(p_task_id uuid, p_approved boolean, p_reason text): jsonb`.

- [ ] **Step 1: Write failing duplicate-code transaction tests**

Assert that one confirmation:

- resolves the task as `same_product_multiple_codes`;
- sets source evidence `is_excluded = true`;
- inserts `recount_code_resolutions`;
- inserts an audit record;
- cannot be repeated to subtract quantity twice.

- [ ] **Step 2: Implement duplicate-code confirmation**

Require the latest attempt result to be `duplicate_first_count`. Lock task and evidence rows, exclude the redundant source row, complete the task, and return source row ID plus safe resolution status.

- [ ] **Step 3: Implement genuine-surplus review**

Counter submission moves the task to manager review without changing totals. Manager approval resolves `genuine_surplus`; rejection reopens the task and requires a reason.

- [ ] **Step 4: Add confirmation and review UI**

The duplicate popup shows masked original code, masked existing serial, SKU, and both BIN values. Add explicit `Xác nhận hai mã cùng một sản phẩm`. Manager Tab 3 gains a genuine-surplus review filter and approve/reject actions.

- [ ] **Step 5: Verify total calculation helpers**

Test that excluded source detail rows contribute zero, corrected serial contributes one, and genuine surplus contributes one only after manager approval.

- [ ] **Step 6: Run tests and commit**

Commit:

```bash
git add index.html recount_domain.js tests/test_recount_domain.mjs supabase/migrations/202609160001_secure_second_count.sql supabase/tests/secure_second_count_test.sql
git commit -m "feat: resolve duplicate product codes in recount"
```

---

### Task 9: Rename Tabs and Integrate Confirmed Results into Reports

**Files:**
- Modify: `index.html`
- Modify: `tests/test_execution_metadata.mjs`
- Modify: `tests/test_recount_domain.mjs`
- Modify: `tests/test_recount_ui.py`

**Interfaces:**
- Consumes confirmed recount task results.
- Produces Tab 4 SKU aggregation and final reconciled detail rows for Tab 5, Excel, PDF, and explanation workbook.

- [ ] **Step 1: Write failing navigation and aggregation tests**

Assert the exact manager labels:

```javascript
[
  "1. Nhập dữ liệu",
  "2. Chi tiết Serial",
  "3. Kiểm đếm lần 2",
  "4. Báo cáo kiểm lần 2",
  "5. Bảng tổng hợp chênh lệch",
  "6. Xuất báo cáo",
  "📅 7. Lưu trữ hàng tháng"
]
```

Test that only completed/manager-approved resolutions modify final totals.

- [ ] **Step 2: Rename and renumber tabs**

Move the existing SKU second-count report content to active Tab 4. Move summary, export, and archive panels to their new indices. Replace numeric index assumptions with named tab constants.

- [ ] **Step 3: Fetch and merge confirmed results**

When managers load a session or refresh reports, fetch the active/latest recount batch and confirmed resolutions, then call `applyConfirmedRecounts`. Preserve original raw session data and store the recalculated detail/count snapshots on the next save.

- [ ] **Step 4: Update exports**

Filter `excludedFromActual` rows from active Excel/PDF detail tables. Ensure duplicate-code audit text appears only in the audit/recount report, not as an active discrepancy note. Preserve the rule that balanced SKUs show no discrepancy note.

- [ ] **Step 5: Add incomplete-work warning**

Before export, show incomplete task counts. Allow export of the currently confirmed snapshot only after the manager acknowledges that unconfirmed recount work is excluded.

- [ ] **Step 6: Run all regression tests and commit**

Commit:

```bash
git add index.html tests/test_execution_metadata.mjs tests/test_recount_domain.mjs tests/test_recount_ui.py
git commit -m "feat: report confirmed second-count results"
```

---

### Task 10: Load, Security, and End-to-End Verification

**Files:**
- Create: `tests/generate_recount_fixture.mjs`
- Create: `tests/test_recount_ui.py`
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**
- Produces repeatable 20,000-row performance fixture.
- Produces a release verification checklist with measurable pass conditions.

- [ ] **Step 1: Add deterministic fixture generator**

Generate 20,000 serial rows across 2,500 SKUs, 10% discrepancies, repeated suffix groups for masking, 20 counter aliases, and mixed missing/wrong/surplus outcomes. Use a fixed seed and write to `tests/fixtures/recount_20000.json` only when invoked.

- [ ] **Step 2: Add security-response assertions**

The E2E test captures browser network responses for a counter session and fails if any expected full serial fixture occurs in response bodies, DOM, localStorage, sessionStorage, or console messages.

- [ ] **Step 3: Add concurrency scenario**

Two authenticated browser contexts open the same task. Reassign it from the manager context; assert the previous counter receives a conflict, cannot submit, and the new counter can complete it once.

- [ ] **Step 4: Measure pagination and completion latency**

Pass conditions on the production-sized test dataset:

- first 100-task page returned without retrieving all 20,000 rows;
- no response contains more than 200 task records;
- scan RPC p95 under 750 ms in the pilot Supabase project;
- task-list p95 under 1.5 s;
- no complete expected serial exposed to the counter.

- [ ] **Step 5: Run the full verification suite**

Run:

```bash
python -m unittest discover -s tests -p 'test_*.py'
node tests/test_execution_metadata.mjs
node tests/test_recount_domain.mjs
supabase db reset
supabase test db supabase/tests/secure_second_count_test.sql
python tests/test_recount_ui.py
git diff --check
```

- [ ] **Step 6: Update deployment documentation**

Document exact order:

1. Apply Supabase migration.
2. Deploy `admin-user-lifecycle` with JWT verification enabled.
3. Configure Edge Function service-role secret server-side.
4. Configure custom SMTP and redirect URLs.
5. Register intended admin and run `private.bootstrap_initial_admin` from SQL Editor.
6. Approve pilot counters and map ERP names.
7. Deploy Streamlit commit with legacy anonymous flag temporarily enabled for managers.
8. Run pilot and validate reports.
9. Disable anonymous Auth and remove legacy flag.

- [ ] **Step 7: Commit verification assets**

Commit:

```bash
git add tests/generate_recount_fixture.mjs tests/test_recount_ui.py .gitignore README.md
git commit -m "test: verify secure recount workflow at scale"
```

---

### Task 11: Production Migration and Go-Live

**Files:**
- Modify only if verification finds a release-blocking issue.

**Interfaces:**
- Consumes the verified commits from Tasks 1–10.
- Produces a migrated Supabase project and deployed Streamlit application.

- [ ] **Step 1: Back up production**

Create a Supabase database backup/export and export current `inventory_sessions` and `monthly_archives` before applying schema changes.

- [ ] **Step 2: Apply schema migration**

Run the migration against production and execute read-only checks for every new table, function, policy, and index. Do not disable anonymous access yet.

- [ ] **Step 3: Deploy Edge Function and configure secrets**

Verify an unauthorized request returns 401, a counter request returns 403, and an admin test request succeeds against a disposable test account.

- [ ] **Step 4: Bootstrap admin and pilot accounts**

Register the intended admin, promote it through the private bootstrap function, approve a small counter group, and map exact ERP names.

- [ ] **Step 5: Deploy Streamlit and run smoke tests**

Smoke-test current file import, reconciliation, session save/load, masked task creation, counter scan, duplicate-code confirmation, final summary, Excel, and PDF.

- [ ] **Step 6: Complete pilot and disable anonymous access**

After pilot report totals match the existing manual result, disable anonymous sign-ins in Supabase, remove the legacy anonymous flag from Streamlit secrets, and verify anonymous clients receive no operational data.

- [ ] **Step 7: Push the final verified commit and monitor**

Push `main`, confirm Streamlit deployment, and monitor Auth errors, RPC latency, database CPU/memory, and failed recount attempts during the first live inventory cycle.
