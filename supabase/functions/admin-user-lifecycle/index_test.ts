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

function fixture(caller: Profile, target: Profile) {
  const calls = { rpc: [] as unknown[], deleted: [] as unknown[], unbanned: [] as unknown[], userTokens: [] as string[] };
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
        maybeSingle: async () => ({ data: id === caller.id ? caller : id === target.id ? target : null, error: null }),
      };
      return query;
    },
    rpc: async (name: string, args: unknown) => {
      calls.rpc.push({ name, args });
      return { data: null, error: null };
    },
  };
  const serviceClient = {
    auth: { admin: {
      deleteUser: async (id: string, soft: boolean) => {
        calls.deleted.push({ id, soft });
        return { data: {}, error: null };
      },
      updateUserById: async (id: string, attributes: unknown) => {
        calls.unbanned.push({ id, attributes });
        return { data: {}, error: null };
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

Deno.test("rejects an active counter caller", async () => {
  const { handler, calls } = fixture(
    { id: "caller", role: "counter", status: "active" },
    { id: "counter-1", role: "counter", status: "active" },
  );
  const response = await handler(request("delete_user"));
  assertEquals(response.status, 403);
  assertEquals(calls.rpc, []);
  assertEquals(calls.deleted, []);
});

Deno.test("manager soft-deletes Auth and database access for a counter", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "active" },
  );
  const response = await handler(request("delete_user"));
  assertEquals(response.status, 200);
  assertEquals(calls.userTokens, ["valid-jwt"]);
  assertEquals(calls.rpc, [{ name: "manager_delete_profile", args: { p_user_id: "counter-1" } }]);
  assertEquals(calls.unbanned, [{ id: "counter-1", attributes: { ban_duration: "876000h" } }]);
  assertEquals(calls.deleted, []);
});

Deno.test("manager cannot delete an admin", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "admin-1", role: "admin", status: "active" },
  );
  const response = await handler(request("delete_user", "admin-1"));
  assertEquals(response.status, 403);
  assertEquals(calls.rpc, []);
  assertEquals(calls.deleted, []);
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
  assertEquals(calls.unbanned, [{ id: "counter-1", attributes: { ban_duration: "876000h" } }]);
  assertEquals(calls.deleted, []);
});

Deno.test("manager unbans Auth before activating a locked counter", async () => {
  const { handler, calls } = fixture(
    { id: "manager-1", role: "manager", status: "active" },
    { id: "counter-1", role: "counter", status: "locked" },
  );
  const response = await handler(request("unlock_user"));
  assertEquals(response.status, 200);
  assertEquals(calls.unbanned, [{ id: "counter-1", attributes: { ban_duration: "none" } }]);
  assertEquals(calls.rpc, [{ name: "manager_unlock_profile", args: { p_user_id: "counter-1" } }]);
  assertEquals(calls.deleted, []);
});
