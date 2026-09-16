# Secure Second-Count Workflow Design

**Date:** 2026-09-16  
**Status:** Approved in conversation; awaiting final document review  
**Scope:** One inventory branch only

## 1. Purpose

Add a secure second-count workflow to the existing inventory reconciliation application. Staff must be able to recount assigned discrepancies without seeing complete expected serial numbers. Managers retain the current import, reconciliation, reporting, assignment, and account-management capabilities.

The feature also replaces anonymous access with named Supabase Auth accounts and database-enforced role-based access control.

## 2. Approved Scope

### Included

- One branch only; there is no branch selector or `branch_id` authorization layer.
- User self-registration followed by manager approval.
- Three application roles: `admin`, `manager`, and `counter`.
- Account approval, locking, and deletion of login access.
- Mapping an ERP counter name to one application profile.
- Automatic second-count assignment to the first-count performer.
- Manager bulk selection and reassignment.
- Server-side serial masking and comparison.
- Second-count completion and confirmation.
- Review and removal of duplicate barcode/IMEI rows from active totals.
- A renamed second-count report tab and renumbered subsequent tabs.
- Audit history for account, assignment, recount, reopening, and duplicate-code actions.

### Excluded

- Multi-branch data isolation or branch administration.
- A persistent global barcode/IMEI equivalence catalog.
- Migration of all existing inventory JSON payloads into fully normalized inventory tables.
- A separate application or deployment for counter users.
- Offline-first scanning. Retrying failed online submissions is supported, but unsent browser data is not treated as completed work.

## 3. Recommended Architecture

Keep the current manager workflow and existing `inventory_sessions` JSON payloads. Add a normalized, secured recount subsystem for discrepancy rows only.

The browser must never receive the complete expected serial for a counter task. Full expected serials live in a protected table that is not selectable by counter users. Counter-facing queries return only masked serials and task metadata. Barcode validation runs through database RPC functions that compare normalized values server-side and return only status codes and safe display data.

This hybrid design limits migration risk while allowing concurrent counters, row-level authorization, auditable state transitions, and efficient pagination.

## 4. Navigation and Role-Based UI

### Admin and manager navigation

1. Nhập dữ liệu
2. Chi tiết Serial
3. Kiểm đếm lần 2
4. Báo cáo kiểm lần 2
5. Bảng tổng hợp chênh lệch
6. Xuất báo cáo
7. Lưu trữ hàng tháng

Tab 4 replaces the existing tab named `3. Kiểm đếm Lần 2`. Existing later tabs retain their names and receive the next sequence number.

### Counter navigation

A `counter` sees only the `Kiểm đếm lần 2` workspace, account information, sign-out, and password-management actions. Hiding navigation is not the security boundary; RLS and RPC authorization enforce access on the server.

## 5. Identity and Account Lifecycle

### Registration

A user registers with:

- Email
- Password
- Full name
- ERP counter name

Registration creates a Supabase Auth user and a `profiles` row with status `pending` and role `counter`. A pending account can sign in only to see the waiting-for-approval screen.

### Approval

An admin or manager approves a pending account. Approval requires an ERP counter name that is not already assigned to another active profile. The normalized ERP name is unique across active and pending profiles.

### Locking

Locking an account immediately prevents access to operational data. All incomplete tasks assigned to that user return to `unassigned`. Completed recount and audit records retain immutable snapshots of the user's name and ERP name.

### Deletion

Deleting a user removes login access from Supabase Auth and marks the profile as deleted. It does not physically delete recount or audit history. Any incomplete task returns to `unassigned`. The deleted profile is excluded from assignment lists.

### Roles

- `admin`: manage all accounts, roles, configuration, sessions, recounts, and audit history.
- `manager`: approve, lock, and delete counter accounts; import and reconcile data; create, assign, reopen, and report recounts.
- `counter`: view and process only tasks assigned to their own authenticated user ID.

Managers cannot promote users to `admin`; only an admin can change the `admin` role.

## 6. Data Model

### `profiles`

- `id uuid primary key` referencing `auth.users(id)`
- `email text not null`
- `full_name text not null`
- `erp_name text not null`
- `erp_name_normalized text not null`
- `role app_role not null default 'counter'`
- `status profile_status not null default 'pending'`
- `approved_by uuid null`
- `approved_at timestamptz null`
- `locked_at timestamptz null`
- `deleted_at timestamptz null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

The normalized ERP name has a partial unique index for non-deleted profiles.

### `recount_batches`

- `id uuid primary key`
- `inventory_session_id uuid not null`
- `status recount_batch_status not null`
- `created_by uuid not null`
- `created_at timestamptz not null`
- `closed_at timestamptz null`
- `version integer not null default 1`

Allowed states are `draft`, `active`, `completed`, and `reopened`.

### `recount_tasks`

- `id uuid primary key`
- `batch_id uuid not null`
- `source_detail_row_id text not null`
- `sku text not null`
- `product_name text not null`
- `stock_bin text null`
- `first_count_bin text null`
- `first_count_status text not null`
- `first_counter_erp_name text null`
- `first_counter_name_snapshot text null`
- `assigned_user_id uuid null`
- `assigned_name_snapshot text null`
- `task_type recount_task_type not null`
- `masked_reference text not null`
- `state recount_task_state not null`
- `resolution recount_resolution null`
- `reason text null`
- `completed_by uuid null`
- `completed_by_name_snapshot text null`
- `completed_at timestamptz null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Allowed task types are `missing_serial`, `wrong_serial`, and `surplus_scan`. Task states are `unassigned`, `assigned`, `in_progress`, `ready`, `completed`, and `reopened`.

`source_detail_row_id` is unique inside a batch so regenerating a draft batch is idempotent.

### `recount_task_secrets`

- `task_id uuid primary key`
- `expected_serial_normalized text null`
- `first_scanned_code_normalized text null`
- `first_scanned_code_masked text null`
- `created_at timestamptz not null`

This table is not selectable through the public Data API by a counter. Validation occurs only through authorized RPC functions.

### `recount_attempts`

- `id uuid primary key`
- `task_id uuid not null`
- `user_id uuid not null`
- `user_name_snapshot text not null`
- `scanned_value_hash text null`
- `scanned_value_masked text null`
- `result recount_attempt_result not null`
- `reason text null`
- `created_at timestamptz not null`

The clear scanned value is not returned to the counter after validation. Allowed results include `matched`, `duplicate_first_count`, `wrong_sku`, `unknown_serial`, `duplicate_attempt`, and `not_found`.

### `recount_code_resolutions`

- `id uuid primary key`
- `task_id uuid not null`
- `resolution_type text not null`
- `removed_source_detail_row_id text null`
- `confirmed_by uuid not null`
- `confirmed_by_name_snapshot text not null`
- `confirmed_at timestamptz not null`

This stores session-scoped confirmation that a barcode/IMEI row and an existing serial identify the same physical product. It is not reused automatically in later inventory sessions.

### `audit_logs`

- `id bigint generated always as identity primary key`
- `actor_user_id uuid null`
- `actor_name_snapshot text not null`
- `action text not null`
- `entity_type text not null`
- `entity_id text not null`
- `before_data jsonb null`
- `after_data jsonb null`
- `reason text null`
- `created_at timestamptz not null`

## 7. Task Generation and Assignment

When detailed reconciliation finishes, a manager can create or refresh a draft recount batch. Only current discrepancy rows create tasks:

- `Bắn thiếu (Chưa quét)` creates `missing_serial`.
- `Bắn sai serial` creates `wrong_serial`.
- `Bắn dư serial` and duplicate-scan variants create `surplus_scan`.

Resolved rows do not create active tasks.

The system normalizes `first_counter_erp_name` and looks for one active approved profile with the same normalized `erp_name`. A unique match receives the assignment. Missing or ambiguous matches remain `unassigned`.

A manager can filter tasks, select visible rows or all rows matching the current filter, and assign them to one active counter. Every assignment change creates an audit entry.

## 8. Serial Masking

Masking is computed per SKU on the server.

1. Default display reveals only the final four characters and replaces every preceding character with `*`.
2. If the final four characters are not unique among task references for the same SKU, the server finds the earliest differing position across those serials.
3. It reveals a four-character window beginning at the earliest differing position, or shifts the window left when fewer than four characters remain.
4. Every character outside that window is replaced with `*`.
5. A complete serial is never returned to a counter, included in browser state, embedded in HTML, or written to client logs.

Examples:

- Default: `********AB12`
- Middle differentiator: `****7X9Q****`

## 9. Counter Workflow

The counter table contains:

`STT | SKU | Tên SP | Serial cần kiểm đã che | BIN tồn | Kết quả lần 1 | Người kiểm lần 1 | Serial bổ sung | Kết quả quét`

The table supports paging, status/SKU/BIN search, sorting, and a per-table wrap-text toggle for product names and notes. The initial page size is 100 rows and may be changed to 50 or 200.

### Scanning

The counter enters or scans a value into `Serial bổ sung` and presses Enter. An RPC validates the task ownership, active state, scan value, expected serial, SKU, and prior attempts in one transaction.

Safe result responses are:

- `Khớp`
- `Serial đã tồn tại trong kết quả lần 1`
- `Đã quét trùng trong lần 2`
- `Serial thuộc SKU khác`
- `Không nhận diện được serial tồn`

The response never includes the complete expected serial.

### Not found

The counter can choose `Không tìm thấy`. A non-empty custom reason is mandatory. No sentence prefix is added to the reason.

### Completing assigned work

`Kiểm đếm xong` is enabled only when every currently assigned active task has either a successful resolution or a not-found reason. The confirmation dialog displays counts for matched, not found, unresolved errors, and duplicate-code confirmations.

Confirmation locks the counter's completed task set, writes `completed_at`, and creates one audit event. Only a manager can reopen completed tasks, and a reopen reason is mandatory.

## 10. Surplus Scan and Multiple-Code Resolution

A surplus scan is not automatically treated as surplus inventory. The first-count code can be a duplicate scan, IMEI, alternate barcode, unknown code, or genuine extra stock.

The counter locates the physical product using SKU, product name, first-count BIN, and masked first-count code, then scans the correct product serial.

### Correct serial belongs to stock and was not counted in round one

The correct serial replaces the wrong first-count code for the active calculation. The task resolves as a corrected serial and the final SKU count is recalculated.

### Correct serial already exists in round one

The RPC returns `duplicate_first_count`. The UI offers `Xác nhận hai mã thuộc cùng một sản phẩm` and displays only masked versions of both codes, the SKU, and both BIN values.

After confirmation:

- The barcode/IMEI source row is marked `excluded_same_product_code`.
- It is removed from active actual quantity, discrepancy totals, Excel exports, and PDF exports.
- The remaining original serial row continues to count as one physical product.
- The SKU total and discrepancy are recalculated immediately.
- The task resolves as `same_product_multiple_codes`.
- A `recount_code_resolutions` record and audit log preserve who confirmed the action, when, and which source row was excluded.

The row is logically excluded rather than physically deleted so that inventory totals remain explainable.

### Correct serial belongs to another SKU

The scan is rejected as `wrong_sku`. The task remains active.

### Code is unknown

The scan is rejected as `unknown_serial`. The task remains active.

### Product is not physically present

The counter selects `Quét nhầm lần 1`, enters a mandatory custom reason, and submits it for resolution.

### Genuine extra stock

The counter selects `Xác nhận hàng dư`, enters a mandatory custom reason, and the task moves to manager review. It affects final totals only after manager approval.

## 11. Manager Recount Workspace

Managers see the same task table plus:

- Checkbox selection per row
- Select all current filtered results
- Bulk assignee selector
- Filters for assignee, state, task type, SKU, and BIN
- Progress totals by counter
- Unassigned task count
- Manager review queue for genuine surplus
- Reopen action with mandatory reason

Bulk actions operate server-side against explicit task IDs or a validated filter request and create audit logs.

## 12. Second-Count Report and Downstream Totals

Tab `4. Báo cáo kiểm lần 2` aggregates confirmed results by SKU:

- Book quantity
- Round-one actual quantity
- Valid supplemental serial count
- Excluded duplicate barcode/IMEI count
- Confirmed genuine surplus count
- Final actual quantity
- Final discrepancy
- Final reason/status

Only completed or manager-approved resolutions affect final totals. Draft, active, failed, and unconfirmed scans do not affect Tab 5 or exports.

Excel and PDF generation use the final confirmed calculation. Rows logically excluded as alternate barcode/IMEI are absent from active report tables. The audit report retains their resolution history.

## 13. Authorization and RLS

- Anonymous authentication is disabled after account rollout.
- All exposed tables have RLS enabled.
- A pending, locked, or deleted profile cannot read operational data.
- Counters can select only safe task columns for rows where `assigned_user_id = auth.uid()`.
- Counters cannot select `recount_task_secrets`.
- Counters can call validation and completion RPCs only for their own assigned active tasks.
- Managers can read and update recount data and manage `counter` profiles.
- Admins have manager permissions and can manage manager/admin roles.
- RLS checks use indexed profile and assignment columns and wrap stable identity lookups in `select` where appropriate.
- Authorization data is not trusted from editable user metadata.

## 14. Concurrency and Transactions

Scan validation locks the target task row for the duration of the RPC. The RPC verifies the current assignee and task version before writing an attempt. A stale or already completed task returns a conflict response and does not write a partial result.

Duplicate-code confirmation, source-row exclusion, count recalculation, task resolution, and audit insertion occur in one database transaction.

Manager reassignment increments task version. A counter holding an old page receives a reassigned-task response and must refresh.

## 15. Error Handling

- Network failure: retain the input visibly, mark it unsent, and allow an explicit retry. Do not mark completion.
- Authentication expiry: redirect to sign-in without discarding the visible unsent value.
- Permission failure: show that the task is no longer assigned and refresh the list.
- Duplicate submission: RPC idempotency prevents duplicate counting.
- Invalid import metadata: tasks remain unassigned and managers see the unmatched ERP name.
- Account deletion with open tasks: tasks become unassigned in the same administrative operation.
- Report generation with incomplete tasks: show the number of incomplete tasks and exclude their unconfirmed changes.

## 16. Performance

The target workload is one branch with up to 20,000 serial rows per inventory session. Recount rows are queried with pagination rather than loaded completely into the browser.

Required indexes include:

- `profiles(status, role)`
- Partial unique index on `profiles(erp_name_normalized)` for non-deleted profiles
- `recount_batches(inventory_session_id, status)`
- `recount_tasks(batch_id, assigned_user_id, state)`
- `recount_tasks(batch_id, sku)`
- `recount_tasks(batch_id, task_type, state)`
- Unique `recount_tasks(batch_id, source_detail_row_id)`
- `recount_attempts(task_id, created_at desc)`
- `audit_logs(entity_type, entity_id, created_at desc)`

Production starts on Supabase Pro Micro. A synthetic 20,000-serial load test and concurrent-counter test are required before release. Compute can be raised to Small without changing the design if observed latency or memory pressure requires it.

## 17. Migration and Rollout

1. Add new enums, tables, indexes, triggers, RPCs, and RLS policies without changing current session tables.
2. Create the initial admin account through a controlled migration.
3. Add sign-up, sign-in, pending approval, and account administration.
4. Add draft recount generation and manager assignment.
5. Add the counter-only workspace and secure validation RPCs.
6. Add final-total synchronization and report integration.
7. Test with synthetic and copied non-production data.
8. Pilot with a small counter group.
9. Disable anonymous authentication only after all required staff accounts are approved.
10. Enable the feature for the full branch and monitor database, Auth, and error metrics.

Existing saved sessions remain readable. A manager must generate a new recount batch from a loaded session to use the new workflow.

## 18. Testing Requirements

- Unit tests for serial normalization and both masking modes.
- Unit tests for ERP-name normalization and unique mapping.
- Database tests for every RLS role/status combination.
- Database tests proving counters cannot retrieve full serials.
- RPC tests for matched, duplicate first-count, duplicate second-count, wrong SKU, unknown serial, and not-found cases.
- Transaction tests for two users submitting against the same task.
- Tests for manager reassignment during an open counter page.
- Tests for lock/delete behavior and unassignment.
- Tests for duplicate barcode/IMEI exclusion and immediate total recalculation.
- Regression tests for current reconciliation formulas and custom notes.
- Excel/PDF tests proving excluded codes do not appear in active totals.
- A 20,000-serial load test with paginated task retrieval.
- End-to-end tests for registration, approval, sign-in, recount completion, report output, and sign-out.

## 19. Acceptance Criteria

The feature is accepted when:

1. A counter cannot obtain any complete expected serial through the UI, application state, network responses, or permitted Supabase queries.
2. A counter sees only assigned work and cannot access manager tabs or another user's tasks.
3. Default assignments follow the mapped first-count ERP performer, while managers can bulk reassign tasks.
4. Serial masking follows the approved final-four/middle-difference rules.
5. Completion requires a valid resolution for every assigned task.
6. Duplicate barcode/IMEI confirmation removes the redundant source row from active quantity and all operational reports while retaining audit history.
7. Only confirmed second-count results affect final discrepancies and exports.
8. Pending, locked, and deleted accounts cannot access operational data.
9. Existing manager reconciliation and export behavior continues to pass regression tests.
10. The system completes the approved 20,000-serial load test without exposing full serials or loading all task rows into one browser response.
