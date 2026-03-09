import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const NOAA_PLASMA_2H =
  "https://services.swpc.noaa.gov/products/solar-wind/plasma-2-hour.json";
const NOAA_MAG_2H =
  "https://services.swpc.noaa.gov/products/solar-wind/mag-2-hour.json";

const ALERT_DEBOUNCE_MS = 2 * 60 * 60 * 1000;
const MAX_SUBSCRIPTIONS_PER_RUN = 250;

type DbSubscription = {
  id: string;
  installation_id: string;
  enabled: boolean;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  onesignal_subscription_id: string | null;
  last_notified_at: string | null;
  last_notified_level: string | null;
};

type SolarWindNow = {
  timeTag: string;
  speedKms: number;
  densityPcm3: number;
  btNt?: number;
  bzNt?: number;
};

type CloudCoverPoint = { timeISO: string; cloudCoverPct: number };

type AuroraAssessment = {
  timeZone: string;
  recommendation: "GO" | "MAYBE" | "NO";
  reasons: string[];
  scores: {
    solarScore_0_100: number;
    cloudPenalty_0_100: number;
    finalScore_0_100: number;
  };
  solarWind: SolarWindNow;
  cloudCover: {
    now?: CloudCoverPoint;
    plus1h?: CloudCoverPoint;
    plus2h?: CloudCoverPoint;
    plus6h?: CloudCoverPoint;
  };
  stayDecision: {
    decision: "STAY_2H" | "STAY_1H" | "LEAVE";
    bestWindow: "NOW" | "IN_1H" | "IN_2H" | "NONE";
    scoreNow: number;
    score1h: number;
    score2h: number;
    reasons: string[];
  };
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") {
    return undefined;
  }
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseNoaaTable(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0])) {
    return [];
  }
  const keys = rows[0].map((entry) => String(entry));
  const out: Array<Record<string, unknown>> = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row)) {
      continue;
    }
    const obj: Record<string, unknown> = {};
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      obj[keys[keyIndex]] = row[keyIndex];
    }
    out.push(obj);
  }
  return out;
}

function pickLatestWithFields<T extends Record<string, unknown>>(
  rows: T[],
  requiredKeys: string[]
): T | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const valid = requiredKeys.every((key) => row[key] !== undefined && row[key] !== null && row[key] !== "");
    if (valid) {
      return row;
    }
  }
  return undefined;
}

async function fetchJson(url: string, timeoutMs = 12_000): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " for " + url);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSolarWindNow(): Promise<SolarWindNow> {
  const [plasmaJson, magJson] = await Promise.all([
    fetchJson(NOAA_PLASMA_2H),
    fetchJson(NOAA_MAG_2H)
  ]);

  const plasmaRows = parseNoaaTable(plasmaJson);
  const magRows = parseNoaaTable(magJson);
  const plasmaLatest = pickLatestWithFields(plasmaRows, ["time_tag", "speed", "density"]);
  const magLatest = pickLatestWithFields(magRows, ["time_tag", "bt", "bz_gsm"]);

  if (!plasmaLatest) {
    throw new Error("NOAA plasma data missing");
  }

  const speedKms = toNumber(plasmaLatest["speed"]);
  const densityPcm3 = toNumber(plasmaLatest["density"]);
  if (speedKms === undefined || densityPcm3 === undefined) {
    throw new Error("NOAA plasma fields are invalid");
  }

  return {
    timeTag: String(plasmaLatest["time_tag"] || ""),
    speedKms,
    densityPcm3,
    btNt: magLatest ? toNumber(magLatest["bt"]) : undefined,
    bzNt: magLatest ? toNumber(magLatest["bz_gsm"]) : undefined
  };
}

async function fetchCloudCoverPoints(lat: number, lon: number): Promise<{
  timeZone: string;
  times: string[];
  covers: number[];
}> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("hourly", "cloud_cover");
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", "auto");

  const payload = await fetchJson(url.toString());
  const timesRaw = (payload as Record<string, unknown>)?.hourly as Record<string, unknown> | undefined;
  const times = Array.isArray(timesRaw?.time) ? timesRaw.time.map((entry) => String(entry)) : [];
  const covers = Array.isArray(timesRaw?.cloud_cover)
    ? timesRaw.cloud_cover.map((entry) => Number(entry))
    : [];

  if (!times.length || times.length !== covers.length) {
    throw new Error("Open-Meteo cloud cover response invalid");
  }

  return {
    timeZone: String((payload as Record<string, unknown>)?.timezone || ""),
    times,
    covers
  };
}

function nearestHourIndex(timesISO: string[], targetMs: number): number | undefined {
  let bestIdx: number | undefined = undefined;
  let bestDiff = Infinity;
  for (let i = 0; i < timesISO.length; i += 1) {
    const ms = Date.parse(timesISO[i]);
    if (!Number.isFinite(ms)) {
      continue;
    }
    const diff = Math.abs(ms - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function solarScore0to100(sw: SolarWindNow): { score: number; reasons: string[] } {
  const reasons: string[] = [];

  const speedScore = clamp(((sw.speedKms - 350) / 300) * 60, 0, 60);
  if (sw.speedKms >= 450) {
    reasons.push(`Solar wind speed is decent (${sw.speedKms.toFixed(0)} km/s).`);
  } else {
    reasons.push(`Solar wind speed is modest (${sw.speedKms.toFixed(0)} km/s).`);
  }

  const densityScore = clamp((sw.densityPcm3 / 20) * 20, 0, 20);
  if (sw.densityPcm3 >= 10) {
    reasons.push(`Particle density is elevated (${sw.densityPcm3.toFixed(1)} p/cm³).`);
  }

  let bzScore = 0;
  if (sw.bzNt !== undefined) {
    bzScore = clamp(((5 - sw.bzNt) / 20) * 20, 0, 20);
    if (sw.bzNt <= -5) {
      reasons.push(`IMF Bz is southward (${sw.bzNt.toFixed(1)} nT), which helps auroras.`);
    } else {
      reasons.push(`IMF Bz is not strongly southward (${sw.bzNt.toFixed(1)} nT).`);
    }
  } else {
    reasons.push("IMF Bz unavailable right now (still using speed+density).");
  }

  return {
    score: clamp(speedScore + densityScore + bzScore, 0, 100),
    reasons
  };
}

function recommendationFromScore(finalScore: number): "GO" | "MAYBE" | "NO" {
  if (finalScore >= 60) {
    return "GO";
  }
  if (finalScore >= 35) {
    return "MAYBE";
  }
  return "NO";
}

function computeViewingScore(solarScore: number, cloudCoverPct: number | undefined): number {
  const cloud = typeof cloudCoverPct === "number" ? clamp(cloudCoverPct, 0, 100) : 100;
  return clamp(solarScore * (1 - cloud / 100), 0, 100);
}

function shouldStayForAurora(params: {
  solarScore_0_100: number;
  bzNt?: number;
  speedKms?: number;
  densityPcm3?: number;
  cloudNowPct?: number;
  cloudPlus1hPct?: number;
  cloudPlus2hPct?: number;
}) {
  const reasons: string[] = [];
  const {
    solarScore_0_100,
    bzNt,
    speedKms,
    densityPcm3,
    cloudNowPct,
    cloudPlus1hPct,
    cloudPlus2hPct
  } = params;

  const scoreNow = computeViewingScore(solarScore_0_100, cloudNowPct);
  const score1h = computeViewingScore(solarScore_0_100, cloudPlus1hPct);
  const score2h = computeViewingScore(solarScore_0_100, cloudPlus2hPct);

  const entries = [
    { w: "NOW" as const, s: scoreNow },
    { w: "IN_1H" as const, s: score1h },
    { w: "IN_2H" as const, s: score2h }
  ].sort((a, b) => b.s - a.s);
  const best = entries[0];

  if (typeof speedKms === "number") {
    reasons.push(`Solar wind speed: ${speedKms.toFixed(0)} km/s.`);
  }
  if (typeof densityPcm3 === "number") {
    reasons.push(`Density: ${densityPcm3.toFixed(1)} p/cm³.`);
  }
  if (typeof bzNt === "number") {
    reasons.push(`Bz: ${bzNt.toFixed(1)} nT.`);
    reasons.push(bzNt <= -5 ? "Bz is southward (favorable)." : "Bz is not strongly southward (less favorable).");
  }

  const fmtCloud = (v?: number) => (typeof v === "number" ? `${v.toFixed(0)}%` : "n/a");
  reasons.push(
    `Cloud cover: now ${fmtCloud(cloudNowPct)}, +1h ${fmtCloud(cloudPlus1hPct)}, +2h ${fmtCloud(cloudPlus2hPct)}.`
  );

  const solarStrong = solarScore_0_100 >= 60;
  const solarOk = solarScore_0_100 >= 40;
  const goodNow = scoreNow >= 35;
  const goodSoon = score1h >= 35 || score2h >= 35;
  const improves1h = score1h - scoreNow >= 12;
  const improves2h = score2h - scoreNow >= 12;

  const cloudClears1h =
    typeof cloudNowPct === "number" &&
    typeof cloudPlus1hPct === "number" &&
    cloudPlus1hPct <= cloudNowPct - 20;

  const cloudClears2h =
    typeof cloudNowPct === "number" &&
    typeof cloudPlus2hPct === "number" &&
    cloudPlus2hPct <= cloudNowPct - 20;

  let decision: "STAY_2H" | "STAY_1H" | "LEAVE" = "LEAVE";
  let bestWindow: "NOW" | "IN_1H" | "IN_2H" | "NONE" = best.s > 0 ? best.w : "NONE";

  if (goodNow && solarOk) {
    decision = "STAY_1H";
    reasons.push("Conditions are decent right now. Aurora activity can come in waves.");
    if ((score1h >= scoreNow - 5 && solarOk) || improves1h || improves2h) {
      decision = "STAY_2H";
      reasons.push("Forecast suggests conditions stay decent or improve within 2 hours.");
    }
  } else if (goodSoon && solarOk) {
    decision = score1h >= score2h ? "STAY_1H" : "STAY_2H";
    reasons.push("Not great now, but forecast suggests a better window soon.");
    if (cloudClears1h) {
      reasons.push("Clouds are expected to clear significantly within ~1 hour.");
    }
    if (cloudClears2h) {
      reasons.push("Clouds are expected to clear significantly within ~2 hours.");
    }
  } else if (solarStrong && (cloudClears1h || cloudClears2h)) {
    decision = cloudClears1h ? "STAY_1H" : "STAY_2H";
    reasons.push("Space weather potential is strong. Waiting for cloud breaks may pay off.");
  } else {
    decision = "LEAVE";
    reasons.push("Not worth waiting here 1–2 hours given current space weather + cloud trend.");
    bestWindow = "NONE";
  }

  reasons.push(
    `Viewing score (0–100): now ${scoreNow.toFixed(0)}, +1h ${score1h.toFixed(0)}, +2h ${score2h.toFixed(0)}. Best: ${best.w} (${best.s.toFixed(0)}).`
  );

  return {
    decision,
    bestWindow,
    scoreNow: Number(scoreNow.toFixed(1)),
    score1h: Number(score1h.toFixed(1)),
    score2h: Number(score2h.toFixed(1)),
    reasons
  };
}

function getHourInTimeZone(timeZone: string, dateValue = new Date()): number {
  const date = new Date(dateValue);
  if (!Number.isFinite(date.getTime())) {
    return NaN;
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: timeZone || undefined
    });
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((entry) => entry.type === "hour");
    const parsed = Number(hourPart?.value || "");
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  } catch {
    // fallback below
  }
  return date.getHours();
}

function isAuroraNightTime(timeZone: string, dateValue = new Date()): boolean {
  const hour = getHourInTimeZone(timeZone, dateValue);
  return Number.isFinite(hour) && (hour >= 18 || hour < 6);
}

async function buildAssessment(lat: number, lon: number): Promise<AuroraAssessment> {
  const [sw, cloud] = await Promise.all([fetchSolarWindNow(), fetchCloudCoverPoints(lat, lon)]);

  const now = Date.now();
  const idxNow = nearestHourIndex(cloud.times, now);
  const idx1h = nearestHourIndex(cloud.times, now + 1 * 3600_000);
  const idx2h = nearestHourIndex(cloud.times, now + 2 * 3600_000);
  const idx6h = nearestHourIndex(cloud.times, now + 6 * 3600_000);

  const point = (idx?: number): CloudCoverPoint | undefined => {
    if (idx === undefined) {
      return undefined;
    }
    const cover = cloud.covers[idx];
    if (!Number.isFinite(cover)) {
      return undefined;
    }
    return {
      timeISO: cloud.times[idx],
      cloudCoverPct: cover
    };
  };

  const cloudCover = {
    now: point(idxNow),
    plus1h: point(idx1h),
    plus2h: point(idx2h),
    plus6h: point(idx6h)
  };

  const cloudValues = [cloudCover.now, cloudCover.plus1h, cloudCover.plus2h, cloudCover.plus6h]
    .map((entry) => entry?.cloudCoverPct)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const bestCloud = cloudValues.length ? Math.min(...cloudValues) : 100;
  const cloudPenalty = clamp(bestCloud, 0, 100);

  const solar = solarScore0to100(sw);
  const finalScore = clamp(solar.score * (1 - cloudPenalty / 100), 0, 100);
  const recommendation = recommendationFromScore(finalScore);
  const stayDecision = shouldStayForAurora({
    solarScore_0_100: solar.score,
    bzNt: sw.bzNt,
    speedKms: sw.speedKms,
    densityPcm3: sw.densityPcm3,
    cloudNowPct: cloudCover.now?.cloudCoverPct,
    cloudPlus1hPct: cloudCover.plus1h?.cloudCoverPct,
    cloudPlus2hPct: cloudCover.plus2h?.cloudCoverPct
  });

  const reasons = [
    ...solar.reasons,
    `Best cloud cover in the next ~6h is ${bestCloud.toFixed(0)}%.`,
    `Solar score: ${solar.score.toFixed(0)}/100, cloud penalty: ${cloudPenalty.toFixed(0)}/100, final: ${finalScore.toFixed(0)}/100.`
  ];

  return {
    timeZone: cloud.timeZone,
    recommendation,
    reasons,
    scores: {
      solarScore_0_100: Number(solar.score.toFixed(1)),
      cloudPenalty_0_100: Number(cloudPenalty.toFixed(1)),
      finalScore_0_100: Number(finalScore.toFixed(1))
    },
    solarWind: sw,
    cloudCover,
    stayDecision
  };
}

function levelFromRecommendation(recommendation: string): "strong" | "weak" | "no" | "unknown" {
  if (recommendation === "GO") {
    return "strong";
  }
  if (recommendation === "MAYBE") {
    return "weak";
  }
  if (recommendation === "NO") {
    return "no";
  }
  return "unknown";
}

async function sendOneSignalNotification(payload: {
  appId: string;
  apiKey: string;
  subscriptionId: string;
  heading: string;
  content: string;
  data: Record<string, unknown>;
}): Promise<{ id?: string; errors?: unknown }> {
  const endpoint = "https://api.onesignal.com/notifications?c=push";
  const baseBody = {
    app_id: payload.appId,
    target_channel: "push",
    headings: { en: payload.heading },
    contents: { en: payload.content },
    data: payload.data,
    ios_badgeType: "None",
    ttl: 3600
  };

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: "Key " + payload.apiKey
  };

  const tryRequest = async (body: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { response, parsed };
  };

  const first = await tryRequest({
    ...baseBody,
    include_subscription_ids: [payload.subscriptionId]
  });
  if (first.response.ok) {
    return {
      id: typeof first.parsed.id === "string" ? first.parsed.id : undefined,
      errors: first.parsed.errors
    };
  }

  const firstErrorText = JSON.stringify(first.parsed || {});
  if (!firstErrorText.toLowerCase().includes("include_subscription_ids")) {
    throw new Error("OneSignal API failed: " + first.response.status + " " + firstErrorText);
  }

  const fallback = await tryRequest({
    ...baseBody,
    include_player_ids: [payload.subscriptionId]
  });
  if (!fallback.response.ok) {
    throw new Error(
      "OneSignal fallback failed: " + fallback.response.status + " " + JSON.stringify(fallback.parsed || {})
    );
  }

  return {
    id: typeof fallback.parsed.id === "string" ? fallback.parsed.id : undefined,
    errors: fallback.parsed.errors
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const cronSecret = Deno.env.get("AURORA_ALERT_CRON_SECRET") || "";
  if (cronSecret) {
    const headerValue = request.headers.get("x-cron-secret") || "";
    if (headerValue !== cronSecret) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const oneSignalAppId = Deno.env.get("ONESIGNAL_APP_ID") || "";
  const oneSignalApiKey = Deno.env.get("ONESIGNAL_REST_API_KEY") || "";

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase environment is not configured" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { data: subscriptions, error: listError } = await supabase
    .from("aurora_alert_subscriptions")
    .select(
      "id, installation_id, enabled, latitude, longitude, timezone, onesignal_subscription_id, last_notified_at, last_notified_level"
    )
    .eq("enabled", true)
    .not("onesignal_subscription_id", "is", null)
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .limit(MAX_SUBSCRIPTIONS_PER_RUN);

  if (listError) {
    return jsonResponse({ error: "Failed to list subscriptions", detail: listError.message }, 500);
  }

  const rows = (Array.isArray(subscriptions) ? subscriptions : []) as DbSubscription[];
  const nowMs = Date.now();

  const results: Array<Record<string, unknown>> = [];
  let notifiedCount = 0;
  let evaluatedCount = 0;

  for (const row of rows) {
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    const subscriptionId = String(row.onesignal_subscription_id || "").trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !subscriptionId) {
      continue;
    }

    evaluatedCount += 1;
    const updatePayload: Record<string, unknown> = {
      last_assessed_at: new Date().toISOString()
    };

    try {
      const assessment = await buildAssessment(lat, lon);
      const level = levelFromRecommendation(assessment.recommendation);
      const timeZone = String(assessment.timeZone || row.timezone || "UTC");
      const isNight = isAuroraNightTime(timeZone, new Date());
      const stayDecision = assessment.stayDecision.decision;

      const shouldConsiderNotification =
        isNight && level === "strong" && (stayDecision === "STAY_1H" || stayDecision === "STAY_2H");

      const lastNotifiedAtMs = Date.parse(String(row.last_notified_at || ""));
      const withinDebounce = Number.isFinite(lastNotifiedAtMs)
        ? nowMs - lastNotifiedAtMs < ALERT_DEBOUNCE_MS
        : false;
      const transitioningToStrong = String(row.last_notified_level || "") !== "strong";

      let pushResponse: { id?: string; errors?: unknown } | null = null;
      let pushed = false;

      if (shouldConsiderNotification && (!withinDebounce || transitioningToStrong)) {
        if (oneSignalAppId && oneSignalApiKey) {
          const stayLabel = stayDecision === "STAY_2H" ? "~2h" : "~1h";
          const bestCloud = Math.min(
            ...[assessment.cloudCover.now, assessment.cloudCover.plus1h, assessment.cloudCover.plus2h]
              .map((entry) => Number(entry?.cloudCoverPct))
              .filter((value) => Number.isFinite(value))
          );

          const heading = "🌌 Aurora signal is strong near you";
          const content =
            "Worth staying " +
            stayLabel +
            ". Clouds best around " +
            (Number.isFinite(bestCloud) ? Math.round(bestCloud) + "%" : "n/a") +
            ". Open Iceland Epic now.";

          pushResponse = await sendOneSignalNotification({
            appId: oneSignalAppId,
            apiKey: oneSignalApiKey,
            subscriptionId,
            heading,
            content,
            data: {
              type: "aurora_signal",
              level,
              recommendation: assessment.recommendation,
              stayDecision,
              installationId: row.installation_id,
              tz: timeZone
            }
          });

          pushed = true;
          notifiedCount += 1;

          updatePayload.last_notified_at = new Date().toISOString();
          updatePayload.last_notified_level = level;
          updatePayload.last_notification_payload = {
            heading,
            content,
            oneSignalId: pushResponse.id || null,
            errors: pushResponse.errors || null,
            emittedAt: new Date().toISOString()
          };
        }
      }

      updatePayload.timezone = timeZone;
      updatePayload.last_assessment_level = level;
      updatePayload.last_assessment_payload = {
        recommendation: assessment.recommendation,
        isNight,
        score: assessment.scores,
        stayDecision: assessment.stayDecision,
        cloudCover: assessment.cloudCover,
        solarWind: assessment.solarWind,
        reasons: assessment.reasons.slice(0, 8),
        evaluatedAt: new Date().toISOString()
      };

      const { error: updateError } = await supabase
        .from("aurora_alert_subscriptions")
        .update(updatePayload)
        .eq("id", row.id);

      results.push({
        installationId: row.installation_id,
        level,
        pushed,
        pushId: pushResponse?.id || null,
        updateError: updateError ? updateError.message : null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase
        .from("aurora_alert_subscriptions")
        .update({
          last_assessed_at: new Date().toISOString(),
          last_assessment_level: "unknown",
          last_assessment_payload: {
            error: message,
            failedAt: new Date().toISOString()
          }
        })
        .eq("id", row.id);

      results.push({
        installationId: row.installation_id,
        error: message
      });
    }
  }

  return jsonResponse({
    ok: true,
    configured: Boolean(oneSignalAppId && oneSignalApiKey),
    evaluated: evaluatedCount,
    notified: notifiedCount,
    rows: results
  });
});
