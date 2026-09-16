import { createClient } from "npm:@supabase/supabase-js@2";

type ProfileRole = "admin" | "manager" | "counter";
type ProfileStatus = "pending" | "active" | "locked" | "deleted";
type Profile = { id: string; role: ProfileRole; status: ProfileStatus };

type QueryResult<T> = Promise<{ data: T | null; error: { message?: string; code?: string } | null }>;
type ProfileQuery = {
  select(columns: string): ProfileQuery;
  eq(column: string, value: string): ProfileQuery;
  maybeSingle(): QueryResult<Profile>;
};
type UserClient = {
  auth: { getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: { message?: string } | null }> };
  from(table: string): ProfileQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;
};
type ServiceClient = {
  auth: { admin: {
    updateUserById(id: string, attributes: { ban_duration: string }): Promise<{ data: unknown; error: { message?: string; status?: number } | null }>;
  } };
};

export type LifecycleDependencies = {
  createUserClient(authorization: string): UserClient;
  createServiceClient(): ServiceClient;
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "content-type": "application/json; charset=utf-8" };
const INDEFINITE_BAN_DURATION = "876000h";

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function bearerToken(authorization: string | null) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function userNotFound(error: { message?: string; status?: number } | null) {
  return error?.status === 404 || /user\s+not\s+found/i.test(error?.message || "");
}

async function profileById(client: UserClient, id: string) {
  return await client.from("profiles").select("id, role, status").eq("id", id).maybeSingle();
}

export function createLifecycleHandler(dependencies: LifecycleDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (request.method !== "POST") return response(405, { error: "method_not_allowed" });

    const authorization = request.headers.get("authorization");
    const token = bearerToken(authorization);
    if (!token || !authorization) return response(401, { error: "missing_jwt" });

    let payload: { action?: unknown; target_user_id?: unknown };
    try {
      payload = await request.json();
    } catch (_error) {
      return response(400, { error: "invalid_json" });
    }
    const action = typeof payload.action === "string" ? payload.action : "";
    const targetUserId = typeof payload.target_user_id === "string" ? payload.target_user_id.trim() : "";
    if (!targetUserId || !["delete_user", "unlock_user"].includes(action)) {
      return response(400, { error: "invalid_request" });
    }

    try {
      const userClient = dependencies.createUserClient(authorization);
      const { data: authData, error: authError } = await userClient.auth.getUser(token);
      if (authError || !authData.user) return response(401, { error: "invalid_jwt" });

      const { data: caller, error: callerError } = await profileById(userClient, authData.user.id);
      if (callerError) return response(502, { error: "profile_lookup_failed" });
      if (!caller || caller.status !== "active" || !["manager", "admin"].includes(caller.role)) {
        return response(403, { error: "manager_or_admin_required" });
      }

      const { data: target, error: targetError } = await profileById(userClient, targetUserId);
      if (targetError) return response(502, { error: "target_lookup_failed" });
      if (!target) return response(404, { error: "target_not_found" });
      if (target.role === "admin" || (caller.role === "manager" && target.role !== "counter")) {
        return response(403, { error: "target_role_forbidden" });
      }

      const serviceClient = dependencies.createServiceClient();
      switch (action) {
        case "delete_user": {
          const alreadyDeleted = target.status === "deleted";
          if (!alreadyDeleted) {
            const { error } = await userClient.rpc("manager_delete_profile", { p_user_id: targetUserId });
            if (error) return response(error.code === "42501" ? 403 : 409, { error: "profile_delete_failed", message: error.message || "" });
          }
          const { error: banError } = await serviceClient.auth.admin.updateUserById(targetUserId, {
            ban_duration: INDEFINITE_BAN_DURATION,
          });
          if (banError && !userNotFound(banError)) return response(502, { error: "auth_ban_failed" });
          // The Auth row is intentionally retained. Non-cascading profile/history
          // foreign keys make any auth.users deletion an invalid lifecycle action.
          return response(200, { ok: true, action, target_user_id: targetUserId, already_deleted: alreadyDeleted });
        }
        case "unlock_user": {
          if (target.status !== "locked") return response(409, { error: "target_not_locked" });
          const { error: authError } = await serviceClient.auth.admin.updateUserById(targetUserId, { ban_duration: "none" });
          if (authError) return response(502, { error: "auth_unban_failed" });
          const { error } = await userClient.rpc("manager_unlock_profile", { p_user_id: targetUserId });
          if (error) return response(error.code === "42501" ? 403 : 409, { error: "profile_unlock_failed", message: error.message || "" });
          return response(200, { ok: true, action, target_user_id: targetUserId });
        }
      }
      return response(400, { error: "invalid_request" });
    } catch (_error) {
      return response(500, { error: "internal_error" });
    }
  };
}

function requiredEnvironment(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function productionDependencies(): LifecycleDependencies {
  const url = requiredEnvironment("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY")?.trim()
    || requiredEnvironment("SUPABASE_ANON_KEY");
  const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  return {
    createUserClient: (authorization) => createClient(url, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as UserClient,
    createServiceClient: () => createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as ServiceClient,
  };
}

if (import.meta.main) Deno.serve(createLifecycleHandler(productionDependencies()));
