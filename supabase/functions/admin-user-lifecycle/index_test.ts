import { createLifecycleHandler, type LifecycleDependencies } from "./index.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

type Profile = { id: string; role: "admin" | "manager" | "counter"; status: "pending" | "active" | "locked" | "deleted" };
type TestError = { message: string; code?: string; status?: number };
type FixtureOptions = {
  userRpcErrors?: Record<string, TestError | TestError[]>;
  serviceRpcErrors?: Record<string, TestError | TestError[]>;
  authErrors?: Record<string, TestError | TestError[]>;
  onRpc?: (name: string, target: Profile) => void;
  onAuthUpdate?: (duration: string, target: Profile) => void;
  clearUnlockLeaseOnAuthUpdate?: boolean;
  waitForTargetReads?: number;
};

function fixture(caller: Profile, target: Profile, options: FixtureOptions = {}) {
  let unlockOperationId: string | null = null;
  let authBanned = target.status !== "active";
  let targetReadCount = 0;
  let releaseTargetReads: (() => void) | null = null;
  const targetReadBarrier = new Promise<void>((resolve) => { releaseTargetReads = resolve; });
  const calls = {
    rpc: [] as unknown[],
    serviceRpc: [] as unknown[],
    authUpdates: [] as unknown[],
    userTokens: [] as string[],
    events: [] as string[],
  };
  const nextError = (errors: Record<string, TestError | TestError[]> | undefined, name: string) => {
    const configured = errors?.[name];
    if (Array.isArray(configured)) return configured.shift() || null;
    return configured || null;
  };
  const userClient = {
    auth: {
      getUser: async (token: string) => {
        calls.userTokens.push(token);
        return { data: { user: { id: caller.id } }, error: null };
      },
    },
    from: (table: string) => {
      assertEquals(table, "profiles");
      let id = "";
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => { id = value; return query; },
        maybeSingle: async () => {
          calls.events.push(`profile:${id}`);
          if (id === target.id && options.waitForTargetReads) {
            targetReadCount += 1;
            if (targetReadCount >= options.waitForTargetReads) releaseTargetReads?.();
            await targetReadBarrier;
          }
          return { data: id === caller.id ? caller : id === target.id ? target : null, error: null };
        },
      };
      return query;
    },
    rpc: async (name: string, args: unknown) => {
      calls.rpc.push({ name, args });
      calls.events.push(`rpc:${name}`);
      const error = nextError(options.userRpcErrors, name);
      if (error) return { data: null, error };
      if (name === "manager_lock_profile") target.status = "locked";
      if (name === "manager_delete_profile") {
        target.status = "deleted";
        unlockOperationId = null;
      }
      if (name === "manager_begin_profile_unlock") {
        const operationId = (args as { p_operation_id: string }).p_operation_id;
        if (target.status === "active") {
          return { data: { user_id: target.id, status: target.status, outcome: "already_active", owns_transition: false }, error: null };
        }
        if (target.status !== "locked") {
          return { data: { user_id: target.id, status: target.status, outcome: "rejected", owns_transition: false }, error: null };
        }
        if (unlockOperationId) {
          return { data: { user_id: target.id, status: target.status, outcome: "in_progress", owns_transition: false }, error: null };
        }
        unlockOperationId = operationId;
        return { data: { user_id: target.id, status: target.status, outcome: "acquired", owns_transition: true }, error: null };
      }
      options.onRpc?.(name, target);
      return { data: { user_id: target.id, status: target.status }, error: null };
    },
  };
  const serviceClient = {
    auth: { admin: {
      updateUserById: async (id: string, attributes: { ban_duration: string }) => {
        calls.authUpdates.push({ id, attributes });
        calls.events.push(`auth:${attributes.ban_duration}`);
        options.onAuthUpdate?.(attributes.ban_duration, target);
        const error = nextError(options.authErrors, attributes.ban_duration);
        if (options.clearUnlockLeaseOnAuthUpdate && attributes.ban_duration === "none") unlockOperationId = null;
        if (!error) authBanned = attributes.ban_duration !== "none";
        return { data: {}, error };
      },
    } },
    from: userClient.from,
    rpc: async (name: string, args: unknown) => {
      calls.serviceRpc.push({ name, args });
      calls.events.push(`service-rpc:${name}`);
      const error = nextError(options.serviceRpcErrors, name);
      if (error) return { data: null, error };
      if (name === "service_release_profile_unlock") {
        const payload = args as { p_operation_id: string };
        if (unlockOperationId === payload.p_operation_id) unlockOperationId = null;
        return { data: { user_id: target.id, status: target.status, outcome: "released", owns_transition: true }, error: null };
      }
      assertEquals(name, "service_finish_profile_unlock");
      const payload = args as { p_operation_id: string; p_succeeded: boolean };
      if (unlockOperationId !== payload.p_operation_id) {
        return {
          data: {
            user_id: target.id,
            status: target.status,
            outcome: target.status === "active" ? "already_active" : "superseded",
            owns_transition: false,
          },
          error: null,
        };
      }
      if (!payload.p_succeeded) {
        if (target.status === "active") {
          target.status = "locked";
        }
        return { data: { user_id: target.id, status: target.status, outcome: "recovery_pending", owns_transition: true }, error: null };
      }
      if (target.status === "locked") {
        unlockOperationId = null;
        target.status = "active";
        return { data: { user_id: target.id, status: target.status, outcome: "activated", owns_transition: true }, error: null };
      }
      return { data: { user_id: target.id, status: target.status, outcome: "superseded", owns_transition: false }, error: null };
    },
  };
  const dependencies: LifecycleDependencies = {
    createUserClient: (_authorization: string) => userClient,
    createServiceClient: () => serviceClient,
  };
  return {
    handler: createLifecycleHandler(dependencies),
    calls,
    state: { get authBanned() { return authBanned; }, get unlockOperationId() { return unlockOperationId; } },
  };
}

function request(action: string, targetUserId = "counter-1", authorization = "Bearer valid-jwt") {
  return new Request("http://localhost/admin-user-lifecycle", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ action, target_user_id: targetUserId }),
  });
}

Deno.test("rejects a request without a caller JWT", async () => {
  let created = false;
  const handler = createLifecycleHandler({
    createUserClient: () => { created = true; throw new Error("must not create client"); },
    createServiceClient: () => { created = true; throw new Error("must not create client"); },
  });
  const response = await handler(request("delete_user", "counter-1", ""));
  assertEquals(response.status, 401);
  assertEquals(created, false);
});

Deno.test("rejects a JSON null payload with a CORS JSON 400", async () => {
  const { handler } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "active" },
  );
  const response = await handler(new Request("http://localhost/admin-user-lifecycle", {
    method: "POST",
    headers: { authorization: "Bearer valid-jwt", "content-type": "application/json" },
    body: "null",
  }));
  assertEquals(response.status, 400);
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertEquals(await response.json(), { error: "invalid_request" });
});

Deno.test("rejects an active counter caller", async () => {
  const { handler, calls } = fixture(
    { id: "caller", role: "counter", status: "active" },
    { id: "counter-1", role: "counter", status: "active" },
  );
  const response = await handler(request("delete_user"));
  assertEquals(response.status, 403);
  assertEquals(calls.rpc, []);
  assertEquals(calls.authUpdates, []);
});

Deno.test("manager soft-deletes the profile and bans Auth for a counter", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "active" },
  );
  const response = await handler(request("delete_user"));
  assertEquals(response.status, 200);
  assertEquals(calls.userTokens, ["valid-jwt"]);
  assertEquals(calls.rpc, [{ name: "manager_delete_profile", args: { p_user_id: "counter-1" } }]);
  assertEquals(calls.authUpdates, [{ id: "counter-1", attributes: { ban_duration: "876000h" } }]);
});

Deno.test("manager cannot delete an admin", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "admin-1", role: "admin", status: "active" },
  );
  const response = await handler(request("delete_user", "admin-1"));
  assertEquals(response.status, 403);
  assertEquals(calls.rpc, []);
  assertEquals(calls.authUpdates, []);
});

Deno.test("deleting an already-deleted profile is idempotent", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "deleted" },
  );
  const response = await handler(request("delete_user"));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true, action: "delete_user", target_user_id: "counter-1", already_deleted: true });
  assertEquals(calls.rpc, []);
  assertEquals(calls.authUpdates, [{ id: "counter-1", attributes: { ban_duration: "876000h" } }]);
});

Deno.test("a delete retries and surfaces an Auth ban failure while the profile stays deleted", async () => {
  const target: Profile = { id: "counter-1", role: "counter", status: "active" };
  const banError = { message: "Auth unavailable", status: 503 };
  const { handler, calls, state } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    target,
    { authErrors: { "876000h": [banError, banError] } },
  );
  const response = await handler(request("delete_user"));
  const body = await response.json();
  assertEquals(response.status, 502);
  assertEquals(body.recovery_required, true);
  assertEquals(calls.authUpdates.length, 2);
  assertEquals(target.status, "deleted");
  assertEquals(state.authBanned, false);
});

Deno.test("manager owns a locked lease, unbans Auth, then activates the profile", async () => {
  const target: Profile = { id: "counter-1", role: "counter", status: "locked" };
  const { handler, calls, state } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    target,
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 200);
  assertEquals(calls.authUpdates, [{ id: "counter-1", attributes: { ban_duration: "none" } }]);
  assertEquals((calls.rpc[0] as { name: string }).name, "manager_begin_profile_unlock");
  assertEquals((calls.serviceRpc[0] as { name: string }).name, "service_finish_profile_unlock");
  assert(calls.events.indexOf("rpc:manager_begin_profile_unlock") < calls.events.indexOf("auth:none"));
  assert(calls.events.indexOf("auth:none") < calls.events.indexOf("service-rpc:service_finish_profile_unlock"));
  assertEquals(target.status, "active");
  assertEquals(state.authBanned, false);
});

Deno.test("two concurrent unlock requests leave the active account unbanned", async () => {
  const target: Profile = { id: "counter-1", role: "counter", status: "locked" };
  const { handler, calls, state } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    target,
    { waitForTargetReads: 2 },
  );
  const responses = await Promise.all([handler(request("unlock_user")), handler(request("unlock_user"))]);
  assertEquals(responses.map((response) => response.status).sort(), [200, 409]);
  assertEquals(target.status, "active");
  assertEquals(state.authBanned, false);
  assertEquals(calls.authUpdates, [{ id: "counter-1", attributes: { ban_duration: "none" } }]);
});

Deno.test("an unlock reservation RPC failure does not change Auth", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "locked" },
    { userRpcErrors: { manager_begin_profile_unlock: { message: "database unavailable", code: "57000" } } },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 409);
  assertEquals(calls.authUpdates, []);
});

Deno.test("a delete racing after Auth unban wins finalization and restores the Auth ban", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "locked" },
    { onAuthUpdate: (duration, target) => { if (duration === "none") target.status = "deleted"; } },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 409);
  assertEquals(calls.authUpdates, [
    { id: "counter-1", attributes: { ban_duration: "none" } },
    { id: "counter-1", attributes: { ban_duration: "876000h" } },
  ]);
});

Deno.test("a finalizer that observes an already-active account does not re-ban it", async () => {
  const target: Profile = { id: "counter-1", role: "counter", status: "locked" };
  const { handler, calls, state } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    target,
    { onAuthUpdate: (duration, profile) => { if (duration === "none") profile.status = "active"; } },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 200);
  assertEquals(calls.authUpdates, [{ id: "counter-1", attributes: { ban_duration: "none" } }]);
  assertEquals(target.status, "active");
  assertEquals(state.authBanned, false);
});

Deno.test("an Auth unban failure releases the lease and preserves locked banned state", async () => {
  const target: Profile = { id: "counter-1", role: "counter", status: "locked" };
  const { handler, calls, state } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    target,
    { authErrors: { none: { message: "Auth unavailable", status: 503 } } },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 502);
  assertEquals((calls.serviceRpc[0] as { args: { p_succeeded: boolean } }).args.p_succeeded, false);
  assertEquals(calls.authUpdates, [
    { id: "counter-1", attributes: { ban_duration: "none" } },
    { id: "counter-1", attributes: { ban_duration: "876000h" } },
  ]);
  assertEquals(target.status, "locked");
  assertEquals(state.authBanned, true);
});

Deno.test("an Auth failure force-locks an active target still owned by the failing unlock", async () => {
  const target: Profile = { id: "counter-1", role: "counter", status: "locked" };
  const { handler, calls, state } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    target,
    {
      authErrors: { none: { message: "Auth unavailable", status: 503 } },
      onAuthUpdate: (duration, profile) => { if (duration === "none") profile.status = "active"; },
    },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 502);
  assertEquals(target.status, "locked");
  assertEquals(state.authBanned, true);
  assertEquals(calls.authUpdates, [
    { id: "counter-1", attributes: { ban_duration: "none" } },
    { id: "counter-1", attributes: { ban_duration: "876000h" } },
  ]);
});

Deno.test("a failed stale Auth call does not re-ban an authoritative active winner", async () => {
  const target: Profile = { id: "counter-1", role: "counter", status: "locked" };
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    target,
    {
      authErrors: { none: { message: "stale Auth response", status: 503 } },
      onAuthUpdate: (duration, profile) => { if (duration === "none") profile.status = "active"; },
      clearUnlockLeaseOnAuthUpdate: true,
    },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 200);
  assertEquals(target.status, "active");
  assertEquals(calls.authUpdates, [{ id: "counter-1", attributes: { ban_duration: "none" } }]);
});

Deno.test("failed Auth unban and failed lease compensation never expose an active profile", async () => {
  const target: Profile = { id: "counter-1", role: "counter", status: "locked" };
  const compensationError = { message: "database unavailable", code: "57000" };
  const { handler, state } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    target,
    {
      authErrors: { none: { message: "Auth unavailable", status: 503 } },
      serviceRpcErrors: { service_finish_profile_unlock: [compensationError, compensationError] },
    },
  );
  const response = await handler(request("unlock_user"));
  const body = await response.json();
  assertEquals(response.status, 502);
  assertEquals(body.recovery_required, true);
  assertEquals(target.status, "locked");
  assertEquals(state.authBanned, true);
});
