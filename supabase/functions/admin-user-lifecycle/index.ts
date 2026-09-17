import { createClient } from "npm:@supabase/supabase-js@2";

type ProfileRole = "admin" | "manager" | "counter";
type ProfileStatus = "pending" | "active" | "locked" | "deleted";
type Profile = { id: string; role: ProfileRole; status: ProfileStatus };
type LifecycleOutcome = {
  user_id?: unknown;
  status?: unknown;
  outcome?: unknown;
  owns_transition?: unknown;
};
type ClientError = { message?: string; code?: string; status?: number };

type QueryResult<T> = Promise<{ data: T | null; error: ClientError | null }>;
type ProfileQuery = {
  select(columns: string): ProfileQuery;
  eq(column: string, value: string): ProfileQuery;
  maybeSingle(): QueryResult<Profile>;
};
type ProfileReader = { from(table: string): ProfileQuery };
type UserClient = ProfileReader & {
  auth: { getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: { message?: string } | null }> };
  from(table: string): ProfileQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: ClientError | null }>;
};
type ServiceClient = {
  auth: { admin: {
    updateUserById(id: string, attributes: { ban_duration: string }): Promise<{ data: unknown; error: ClientError | null }>;
  } };
  from(table: string): ProfileQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: ClientError | null }>;
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
const RECOVERY_ATTEMPTS = 2;

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

async function profileById(client: ProfileReader, id: string) {
  return await client.from("profiles").select("id, role, status").eq("id", id).maybeSingle();
}

async function restoreLifecycleBan(serviceClient: ServiceClient, targetUserId: string) {
  let lastError: ClientError | null = null;
  for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
    const { error } = await serviceClient.auth.admin.updateUserById(targetUserId, {
      ban_duration: INDEFINITE_BAN_DURATION,
    });
    if (!error || userNotFound(error)) return null;
    lastError = error;
  }
  return lastError;
}

async function finishProfileUnlock(
  serviceClient: ServiceClient,
  targetUserId: string,
  operationId: string,
  succeeded: boolean,
) {
  let lastError: ClientError | null = null;
  for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
    const result = await serviceClient.rpc("service_finish_profile_unlock", {
      p_user_id: targetUserId,
      p_operation_id: operationId,
      p_succeeded: succeeded,
    });
    if (!result.error) return result;
    lastError = result.error;
  }
  return { data: null, error: lastError };
}

async function releaseProfileUnlock(
  serviceClient: ServiceClient,
  targetUserId: string,
  operationId: string,
) {
  let lastError: ClientError | null = null;
  for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt += 1) {
    const result = await serviceClient.rpc("service_release_profile_unlock", {
      p_user_id: targetUserId,
      p_operation_id: operationId,
    });
    if (!result.error) return result;
    lastError = result.error;
  }
  return { data: null, error: lastError };
}

function lifecycleOutcome(data: unknown): LifecycleOutcome | null {
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as LifecycleOutcome
    : null;
}

function unlockSuccess(action: string, targetUserId: string, outcome: string) {
  return response(200, {
    ok: true,
    action,
    target_user_id: targetUserId,
    already_active: outcome === "already_active",
  });
}

async function releaseFailedUnlock(
  serviceClient: ServiceClient,
  targetUserId: string,
  operationId: string,
) {
  const release = await finishProfileUnlock(serviceClient, targetUserId, operationId, false);
  const observed = release.error ? await profileById(serviceClient, targetUserId) : release;
  const observedOutcome = lifecycleOutcome(observed.data);
  const activeWinner = !observed.error && observedOutcome?.status === "active";
  const banError = activeWinner ? null : await restoreLifecycleBan(serviceClient, targetUserId);
  const cleanup = !banError && !activeWinner
    ? await releaseProfileUnlock(serviceClient, targetUserId, operationId)
    : { data: null, error: null };
  return {
    releaseError: release.error,
    banError,
    cleanupError: cleanup.error,
    activeWinner,
  };
}

async function beginProfileUnlock(userClient: UserClient, targetUserId: string, operationId: string) {
  return await userClient.rpc("manager_begin_profile_unlock", {
    p_user_id: targetUserId,
    p_operation_id: operationId,
  });
}

export function createLifecycleHandler(dependencies: LifecycleDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (request.method !== "POST") return response(405, { error: "method_not_allowed" });

    const authorization = request.headers.get("authorization");
    const token = bearerToken(authorization);
    if (!token || !authorization) return response(401, { error: "missing_jwt" });

    let payload: unknown;
    try {
      payload = await request.json();
    } catch (_error) {
      return response(400, { error: "invalid_json" });
    }
    const body = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as { action?: unknown; target_user_id?: unknown }
      : null;
    const action = typeof body?.action === "string" ? body.action : "";
    const targetUserId = typeof body?.target_user_id === "string" ? body.target_user_id.trim() : "";
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
          const banError = await restoreLifecycleBan(serviceClient, targetUserId);
          if (banError) {
            return response(502, {
              error: "auth_ban_failed",
              recovery_required: true,
              message: banError.message || "",
            });
          }
          // The Auth row is intentionally retained. Non-cascading profile/history
          // foreign keys make any auth.users deletion an invalid lifecycle action.
          return response(200, { ok: true, action, target_user_id: targetUserId, already_deleted: alreadyDeleted });
        }
        case "unlock_user": {
          if (target.status === "active") return unlockSuccess(action, targetUserId, "already_active");
          if (target.status !== "locked") return response(409, { error: "target_not_locked" });

          const operationId = crypto.randomUUID();
          const { data: transitionData, error: transitionError } = await beginProfileUnlock(
            userClient,
            targetUserId,
            operationId,
          );
          if (transitionError) {
            return response(transitionError?.code === "42501" ? 403 : 409, {
              error: "profile_unlock_failed",
              message: transitionError?.message || "",
            });
          }

          const transition = lifecycleOutcome(transitionData);
          const outcome = typeof transition?.outcome === "string" ? transition.outcome : "";
          if (outcome === "already_active" && transition?.status === "active") {
            return unlockSuccess(action, targetUserId, outcome);
          }
          if (outcome === "in_progress") {
            return response(409, { error: "unlock_in_progress" });
          }
          if (outcome !== "acquired" || transition?.owns_transition !== true || transition?.status !== "locked") {
            return response(409, { error: "profile_unlock_rejected", status: transition?.status || null });
          }

          const { error: authError } = await serviceClient.auth.admin.updateUserById(targetUserId, {
            ban_duration: "none",
          });
          if (authError) {
            const recovery = await releaseFailedUnlock(serviceClient, targetUserId, operationId);
            if (recovery.activeWinner) {
              return unlockSuccess(action, targetUserId, "already_active");
            }
            return response(502, {
              error: "auth_unban_failed",
              recovery_required: Boolean(recovery.releaseError || recovery.banError || recovery.cleanupError),
            });
          }

          const completion = await finishProfileUnlock(serviceClient, targetUserId, operationId, true);
          const completed = lifecycleOutcome(completion.data);
          const completedOutcome = typeof completed?.outcome === "string" ? completed.outcome : "";
          if (!completion.error && completed?.status === "active"
            && ["activated", "already_active"].includes(completedOutcome)) {
            return unlockSuccess(action, targetUserId, completedOutcome);
          }

          // An authoritative active result means this operation (or a newer
          // successful unlock) won. Never let a stale request re-ban it.
          if (!completion.error && completed?.status === "active") {
            return unlockSuccess(action, targetUserId, "already_active");
          }

          if (completion.error) {
            const { data: currentTarget } = await profileById(serviceClient, targetUserId);
            if (currentTarget?.status === "active") {
              return unlockSuccess(action, targetUserId, "already_active");
            }
          }

          const recovery = await releaseFailedUnlock(serviceClient, targetUserId, operationId);
          if (recovery.activeWinner) {
            return unlockSuccess(action, targetUserId, "already_active");
          }
          if (recovery.banError) {
            return response(502, {
              error: "auth_reban_failed",
              recovery_required: true,
              status: completed?.status || null,
              message: recovery.banError.message || "",
            });
          }
          if (completion.error || recovery.releaseError || recovery.cleanupError) {
            return response(502, {
              error: "unlock_confirmation_failed",
              recovery_required: Boolean(recovery.releaseError || recovery.cleanupError),
            });
          }
          return response(409, {
            error: "unlock_superseded",
            status: completed?.status || null,
          });
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
