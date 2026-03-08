const UMFERDIN_GRAPHQL_URL = "https://umferdin.is/api/graphql";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

type UmferdinRoadEntry = {
  id?: string;
  name?: string;
  lastUpdate?: string;
  roads?: Array<{ nr?: string }>;
  condition?: {
    code?: string;
    description?: string;
    date?: string;
  };
};

function normalizeRoadToken(roadValue: unknown): string {
  const raw = String(roadValue ?? "").trim().toUpperCase();
  if (!raw) {
    return "";
  }
  const match = raw.match(/F?\d{1,3}[A-Z]?/);
  if (!match) {
    return raw.replace(/[^A-Z0-9]/g, "");
  }
  return match[0];
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function mapConditionToStatus(code: unknown, description: unknown): {
  status: string;
  level: string;
} {
  const conditionCode = String(code ?? "").trim();
  const combined = normalizeText(description) + " " + normalizeText(code);

  if (conditionCode === "14" || /\b(easily passable|greidf(a|æ)rt|greidfart|clear)\b/.test(combined)) {
    return { status: "Easily passable", level: "good" };
  }
  if (conditionCode === "23" || /\b(spots? of ice|halkublett|hálkublett)\b/.test(combined)) {
    return { status: "Spots of ice", level: "warn" };
  }
  if (
    conditionCode === "36" ||
    /\b(slippery|halt|hált|halka|hálka|snow|sno)\b/.test(combined)
  ) {
    return { status: "Slippery", level: "warn" };
  }
  if (/\b(impassable|closed|lokad|lokud|lokun|ofaert|ófært)\b/.test(combined)) {
    return { status: "Impassable", level: "bad" };
  }

  return { status: "Unknown", level: "unknown" };
}

function asTimestamp(value: unknown): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { roads?: unknown } = {};
  try {
    body = (await request.json()) as { roads?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const requestedRoads = Array.from(
    new Set((Array.isArray(body.roads) ? body.roads : []).map(normalizeRoadToken))
  )
    .filter(Boolean)
    .slice(0, 24);

  if (!requestedRoads.length) {
    return jsonResponse({ roads: [] });
  }

  const graphqlQuery = {
    query:
      "{ RoadCondition { results { id name lastUpdate roads { nr } condition { code description date } } } }"
  };

  let roadEntries: UmferdinRoadEntry[] = [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const response = await fetch(UMFERDIN_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(graphqlQuery),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return jsonResponse({ error: "Upstream request failed", status: response.status }, 502);
    }

    const payload = await response.json();
    const results = payload?.data?.RoadCondition?.results;
    roadEntries = Array.isArray(results) ? results : [];
  } catch (error) {
    return jsonResponse(
      {
        error: "Failed to fetch road conditions",
        detail: error instanceof Error ? error.message : String(error)
      },
      502
    );
  }

  const roads = requestedRoads
    .map((road) => {
      const matches = roadEntries
        .filter((entry) => {
          const refs = Array.isArray(entry.roads) ? entry.roads : [];
          return refs.some((ref) => normalizeRoadToken(ref?.nr) === road) && entry.condition;
        })
        .sort((left, right) => {
          const leftTs = asTimestamp(left.condition?.date || left.lastUpdate);
          const rightTs = asTimestamp(right.condition?.date || right.lastUpdate);
          return rightTs - leftTs;
        });

      const selected = matches[0];
      if (!selected || !selected.condition) {
        return null;
      }

      const mapped = mapConditionToStatus(selected.condition.code, selected.condition.description);
      return {
        road,
        status: mapped.status,
        level: mapped.level,
        code: String(selected.condition.code ?? ""),
        sourceDescription: String(selected.condition.description ?? ""),
        sectionName: String(selected.name ?? ""),
        updatedAt: String(selected.condition.date || selected.lastUpdate || "")
      };
    })
    .filter(Boolean);

  return jsonResponse({
    roads,
    fetchedAt: new Date().toISOString(),
    source: "umferdin"
  });
});
