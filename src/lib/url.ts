const TRACKING_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);

/**
 * Normalizes a URL for identity/dedup comparisons: strips known tracking
 * params and a trailing slash, drops the fragment. Deliberately narrow —
 * it must never change which page a URL actually points to.
 */
export function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const param of Array.from(url.searchParams.keys())) {
      if (TRACKING_PARAMS.has(param.toLowerCase())) {
        url.searchParams.delete(param);
      }
    }
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}
