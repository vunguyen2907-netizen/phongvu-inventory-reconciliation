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
  rpcErrors?: Record<string, TestError>;
  authErrors?: Record<string, TestError>;
  onRpc?: (name: string, target: Profile) => void;
  onAuthUpdate?: (duration: string, target: Profile) => void;
};

function fixture(caller: Profile, target: Profile, options: FixtureOptions = {}) {
  const calls = { rpc: [] as unknown[], authUpdates: [] as unknown[], userTokens: [] as string[], events: [] as string[] };
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
          return { data: id === caller.id ? caller : id === target.id ? target : null, error: null };
        },
      };
      return query;
    },
    rpc: async (name: string, args: unknown) => {
      calls.rpc.push({ name, args });
      calls.events.push(`rpc:${name}`);
      const error = options.rpcErrors?.[name];
      if (error) return { data: null, error };
      if (name === "manager_unlock_profile") target.status = "active";
      if (name === "manager_lock_profile") target.status = "locked";
      if (name === "manager_delete_profile") target.status = "deleted";
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
        return { data: {}, error: options.authErrors?.[attributes.ban_duration] || null };
      },
    } },
  };
  const dependencies: LifecycleDependencies = {
    createUserClient: (_authorization: string) => userClient,
    createServiceClient: () => serviceClient,
  };
  return { handler: createLifecycleHandler(dependencies), calls };
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

Deno.test("manager activates the locked profile before unbanning Auth", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "locked" },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 200);
  assertEquals(calls.authUpdates, [{ id: "counter-1", attributes: { ban_duration: "none" } }]);
  assertEquals(calls.rpc, [{ name: "manager_unlock_profile", args: { p_user_id: "counter-1" } }]);
  assert(calls.events.indexOf("rpc:manager_unlock_profile") < calls.events.indexOf("auth:none"));
  assert(calls.events.lastIndexOf("profile:counter-1") > calls.events.indexOf("auth:none"));
});

Deno.test("an unlock RPC failure leaves Auth banned", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "locked" },
    { rpcErrors: { manager_unlock_profile: { message: "target was deleted", code: "55000" } } },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 409);
  assertEquals(calls.authUpdates, [
    { id: "counter-1", attributes: { ban_duration: "876000h" } },
  ]);
});

Deno.test("a delete racing after unlock activation restores the Auth ban", async () => {
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
  assert(calls.events.lastIndexOf("profile:counter-1") > calls.events.indexOf("auth:none"));
});

Deno.test("an Auth unban failure restores locked database and Auth state", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "locked" },
    { authErrors: { none: { message: "Auth unavailable", status: 503 } } },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 502);
  assertEquals(calls.rpc, [
    { name: "manager_unlock_profile", args: { p_user_id: "counter-1" } },
    { name: "manager_lock_profile", args: { p_user_id: "counter-1", p_reason: "Auth unlock failed; restored lock" } },
  ]);
  assertEquals(calls.authUpdates, [
    { id: "counter-1", attributes: { ban_duration: "none" } },
    { id: "counter-1", attributes: { ban_duration: "876000h" } },
  ]);
});
