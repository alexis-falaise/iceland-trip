const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const MAX_REDIRECT_HOPS = 8;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders
  });
}

function parseUrl(value: unknown): URL | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isAllowedEntryUrl(url: URL): boolean {
  const host = String(url.hostname || "").toLowerCase();
  if (url.protocol !== "https:") {
    return false;
  }
  if (host === "maps.app.goo.gl") {
    return true;
  }
  if (host === "goo.gl" && /^\/maps(?:\/|$)/i.test(String(url.pathname || ""))) {
    return true;
  }
  return false;
}

function isAllowedRedirectUrl(url: URL): boolean {
  const host = String(url.hostname || "").toLowerCase();
  if (url.protocol !== "https:") {
    return false;
  }
  if (host === "maps.app.goo.gl") {
    return true;
  }
  if (host === "goo.gl") {
    return true;
  }
  if (host === "google.com" || host === "www.google.com") {
    return true;
  }
  if (host === "maps.google.com" || host === "www.maps.google.com") {
    return true;
  }
  return false;
}

async function fetchManualRedirect(url: string, signal: AbortSignal): Promise<Response> {
  const headResponse = await fetch(url, {
    method: "HEAD",
    redirect: "manual",
    signal,
    headers: {
      Accept: "text/html,*/*;q=0.8"
    }
  });

  if (headResponse.status !== 405 && headResponse.status !== 501) {
    return headResponse;
  }

  return fetch(url, {
    method: "GET",
    redirect: "manual",
    signal,
    headers: {
      Accept: "text/html,*/*;q=0.8"
    }
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { url?: unknown } = {};
  try {
    body = (await request.json()) as { url?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const startUrl = parseUrl(body.url);
  if (!startUrl || !isAllowedEntryUrl(startUrl)) {
    return jsonResponse({ error: "Unsupported Google Maps short link" }, 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    let current = startUrl;

    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
      const response = await fetchManualRedirect(current.toString(), controller.signal);
      const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
      if (!isRedirect) {
        return jsonResponse({
          expandedUrl: current.toString(),
          hops: hop,
          finalStatus: response.status
        });
      }

      const locationHeader = response.headers.get("location");
      if (!locationHeader) {
        return jsonResponse({
          expandedUrl: current.toString(),
          hops: hop,
          finalStatus: response.status
        });
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(locationHeader, current);
      } catch {
        return jsonResponse({ error: "Invalid redirect URL" }, 502);
      }

      if (!isAllowedRedirectUrl(nextUrl)) {
        return jsonResponse({ error: "Redirect target not allowed" }, 502);
      }

      current = nextUrl;
    }

    return jsonResponse({
      expandedUrl: current.toString(),
      hops: MAX_REDIRECT_HOPS,
      truncated: true
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "Failed to expand short link",
        detail: error instanceof Error ? error.message : String(error)
      },
      502
    );
  } finally {
    clearTimeout(timeout);
  }
});
