import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

type SubscriptionBody = {
  installationId?: unknown;
  enabled?: unknown;
  coords?: unknown;
  timezone?: unknown;
  oneSignalSubscriptionId?: unknown;
  permission?: unknown;
  language?: unknown;
  userAgent?: unknown;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders
  });
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function parseCoords(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const lat = Number(value[0]);
  const lon = Number(value[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  return [lat, lon];
}

function normalizeString(value: unknown, maxLen: number): string {
  return String(value ?? "").trim().slice(0, maxLen);
}

function isValidInstallationId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{5,120}$/i.test(value);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase environment is not configured" }, 500);
  }

  let body: SubscriptionBody = {};
  try {
    body = (await request.json()) as SubscriptionBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const installationId = normalizeString(body.installationId, 120).toLowerCase();
  if (!installationId || !isValidInstallationId(installationId)) {
    return jsonResponse({ error: "Invalid installationId" }, 400);
  }

  const enabled = parseBoolean(body.enabled);
  const coords = parseCoords(body.coords);
  const timezone = normalizeString(body.timezone, 80);
  const oneSignalSubscriptionId = normalizeString(body.oneSignalSubscriptionId, 128);
  const permission = normalizeString(body.permission, 24);
  const language = normalizeString(body.language, 16).toLowerCase();
  const userAgent = normalizeString(body.userAgent, 220);

  if (enabled && !coords) {
    return jsonResponse({ error: "coords are required when alerts are enabled" }, 400);
  }
  if (enabled && !oneSignalSubscriptionId) {
    return jsonResponse({ error: "oneSignalSubscriptionId is required when alerts are enabled" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const updatePayload = {
    installation_id: installationId,
    enabled,
    latitude: coords ? coords[0] : null,
    longitude: coords ? coords[1] : null,
    timezone: timezone || null,
    onesignal_subscription_id: oneSignalSubscriptionId || null,
    permission: permission || null,
    language: language || null,
    user_agent: userAgent || null,
    last_opened_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from("aurora_alert_subscriptions")
    .upsert(updatePayload, { onConflict: "installation_id" })
    .select("id, installation_id, enabled, latitude, longitude, timezone, onesignal_subscription_id, last_opened_at, updated_at")
    .single();

  if (error) {
    return jsonResponse(
      {
        error: "Failed to save aurora alert subscription",
        detail: error.message
      },
      500
    );
  }

  return jsonResponse({
    ok: true,
    subscription: data
  });
});
