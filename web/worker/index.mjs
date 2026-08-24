const OWNER = "aopv";
const REPOSITORY = "browser-cookie-bridge";
const CACHE_SECONDS = 6 * 60 * 60;
const ONE_DAY = 24 * 60 * 60 * 1000;

const THEMES = {
  dark: {
    background: "#0E1013",
    panel: "#15181D",
    border: "#343A42",
    grid: "#2C3138",
    text: "#F8F3E8",
    muted: "#A8A095",
    tunnel: "#20252B",
  },
  light: {
    background: "#FBF8F1",
    panel: "#FFFFFF",
    border: "#DED5C7",
    grid: "#E7DED1",
    text: "#251B17",
    muted: "#776B62",
    tunnel: "#F1EBE2",
  },
};

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);

    if (url.pathname !== "/api/star-history.svg") {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const themeName = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    const cacheUrl = new URL(url);
    cacheUrl.search = `?theme=${themeName}&v=1`;
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
    const cached = await caches.default.match(cacheKey);

    if (cached) {
      return request.method === "HEAD"
        ? new Response(null, { status: cached.status, headers: cached.headers })
        : cached;
    }

    try {
      const stars = await fetchStarHistory(env.GITHUB_TOKEN);
      const response = svgResponse(renderStarHistorySvg(stars, themeName), CACHE_SECONDS);
      context.waitUntil(caches.default.put(cacheKey, response.clone()));

      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    } catch (error) {
      console.error(JSON.stringify({
        event: "star_history_render_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
      const response = svgResponse(renderErrorSvg(themeName), 60, 503);

      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
  },
};

export async function fetchStarHistory(token, fetchImplementation = fetch) {
  if (!token) {
    throw new Error("GITHUB_TOKEN is not configured");
  }

  const stars = [];

  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchImplementation(
      `https://api.github.com/repos/${OWNER}/${REPOSITORY}/stargazers?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github.star+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "browser-cookie-bridge-star-history",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}`);
    }

    const payload = await response.json();

    if (!Array.isArray(payload)) {
      throw new Error("GitHub returned an unexpected response");
    }

    for (const item of payload) {
      if (typeof item?.starred_at === "string") {
        stars.push(item.starred_at);
      }
    }

    if (payload.length < 100) {
      return stars.sort((left, right) => left.localeCompare(right));
    }
  }

  throw new Error("Star history exceeded the pagination safety limit");
}

export function renderStarHistorySvg(starredAtValues, themeName = "light") {
  const theme = THEMES[themeName] ?? THEMES.light;
  const dark = themeName === "dark";
  const width = 960;
  const height = 520;
  const plot = { left: 76, top: 190, right: 904, bottom: 404 };
  const now = Date.now();
  const dates = starredAtValues
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const rangeStart = Math.min((dates[0] ?? now) - ONE_DAY, now - 30 * ONE_DAY);
  const rangeEnd = Math.max(now, rangeStart + ONE_DAY);
  const yMaximum = niceMaximum(Math.max(dates.length, 1));
  const x = (timestamp) =>
    plot.left +
    ((timestamp - rangeStart) / (rangeEnd - rangeStart)) *
      (plot.right - plot.left);
  const y = (count) =>
    plot.bottom - (count / yMaximum) * (plot.bottom - plot.top);
  const points = cumulativeSamples(dates, rangeStart, rangeEnd, 56).map(
    ([timestamp, count]) => [x(timestamp), y(count)],
  );
  const linePath = smoothPath(points);
  const areaPath = `${linePath} L${plot.right} ${plot.bottom} L${plot.left} ${plot.bottom} Z`;
  const currentStars = dates.length;
  const currentY = y(currentStars);
  const yGrid = tickValues(yMaximum, 6)
    .map((value) => {
      const position = y(value);
      return `<line x1="${plot.left}" y1="${position}" x2="${plot.right}" y2="${position}" class="grid"/>
      <text x="${plot.left - 16}" y="${position + 5}" text-anchor="end" class="axis">${value}</text>`;
    })
    .join("");
  const xLabels = dateTicks(rangeStart, rangeEnd, 4)
    .map((timestamp, index) => {
      const anchor = index === 0 ? "start" : index === 3 ? "end" : "middle";
      return `<text x="${x(timestamp)}" y="${plot.bottom + 37}" text-anchor="${anchor}" class="axis">${formatDate(timestamp, rangeEnd - rangeStart)}</text>`;
    })
    .join("");
  const packets = [0.23, 0.48, 0.72]
    .map((ratio, index) => {
      const [packetX, packetY] = points[Math.round((points.length - 1) * ratio)];
      const fill = index === 1 ? "#58A6FF" : "#C68B3C";
      return `<g transform="translate(${packetX} ${packetY})" filter="url(#handmade)">
        <rect x="-10" y="-10" width="20" height="20" rx="7" fill="${theme.panel}" stroke="${fill}" stroke-width="2"/>
        <circle cx="-3.5" cy="-2" r="2" fill="${fill}"/><circle cx="4" cy="3" r="2.3" fill="${fill}"/><circle cx="3" cy="-4" r="1.2" fill="${fill}"/>
        <path d="M12 -2 H21 M17 -6 L21 -2 L17 2" fill="none" stroke="${fill}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`;
    })
    .join("");
  const ink = dark ? "#FFF9EE" : "#291C17";
  const goldSoft = dark ? "#F2C46D" : "#A76716";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Browser Cookie Bridge GitHub star history</title>
  <desc id="description">${currentStars} GitHub stars over time for ${OWNER}/${REPOSITORY}.</desc>
  <defs>
    <linearGradient id="bridge-line" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#C68B3C"/><stop offset=".48" stop-color="#8E2735"/><stop offset=".72" stop-color="#58A6FF"/><stop offset="1" stop-color="#3DA639"/></linearGradient>
    <linearGradient id="bridge-area" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#C68B3C" stop-opacity=".24"/><stop offset=".62" stop-color="#58A6FF" stop-opacity=".08"/><stop offset="1" stop-color="#58A6FF" stop-opacity="0"/></linearGradient>
    <pattern id="crumbs" width="31" height="31" patternUnits="userSpaceOnUse"><circle cx="5" cy="6" r="1.2" fill="#C68B3C" opacity=".13"/><circle cx="22" cy="19" r=".8" fill="#8E2735" opacity=".1"/></pattern>
    <filter id="handmade" x="-40%" y="-40%" width="180%" height="180%"><feTurbulence type="fractalNoise" baseFrequency=".018" numOctaves="2" seed="19" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale=".75"/></filter>
    <filter id="packet-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="plot"><rect x="${plot.left}" y="${plot.top - 18}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top + 18}"/></clipPath>
    <style>
      .axis{fill:${theme.muted};font:600 13px 'Trebuchet MS',sans-serif}.grid{stroke:${theme.grid};stroke-width:1.1;stroke-dasharray:3 8;stroke-linecap:round}.display{fill:${ink};font:800 25px ui-rounded,'Arial Rounded MT Bold','Trebuchet MS',sans-serif}.body{fill:${theme.muted};font:600 13.5px 'Trebuchet MS',sans-serif}.utility{fill:${theme.muted};font:700 10.5px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px}
    </style>
  </defs>
  <rect width="960" height="520" rx="30" fill="${theme.background}"/>
  <rect x="16" y="16" width="928" height="488" rx="26" fill="${theme.panel}" stroke="${theme.border}" stroke-width="1.5"/>
  <rect x="27" y="27" width="906" height="466" rx="20" fill="url(#crumbs)" stroke="${theme.border}" stroke-dasharray="7 8"/>

  <g transform="translate(45 35)" filter="url(#handmade)">
    <circle cx="25" cy="25" r="23" fill="#C68B3C" stroke="#F2C46D" stroke-width="2"/>
    <path d="M37 6 C33 10 35 17 42 19 C39 25 40 31 45 34 A23 23 0 1 1 37 6Z" fill="${dark ? "#4C2A18" : "#8A4A1D"}" opacity=".68"/>
    <circle cx="16" cy="18" r="4" fill="#5B2D1B"/><circle cx="28" cy="31" r="4.5" fill="#5B2D1B"/><circle cx="13" cy="34" r="2.5" fill="#5B2D1B"/><circle cx="29" cy="15" r="2.7" fill="#5B2D1B"/>
  </g>
  <text x="113" y="55" class="display">Every star crosses the bridge.</text>
  <text x="114" y="79" class="body">Signed-in sessions stay local. The momentum travels farther.</text>
  <g transform="translate(746 35)" filter="url(#handmade)">
    <rect width="141" height="52" rx="17" fill="${dark ? "#2A2116" : "#FFF5DD"}" stroke="#C68B3C" stroke-width="1.5" stroke-dasharray="6 4"/>
    <path d="M25 11 L29 21 L39 22 L31 29 L33 39 L25 34 L16 39 L19 29 L11 22 L21 21Z" fill="#FFD166" filter="url(#packet-glow)"/>
    <text x="49" y="34" fill="${ink}" font-family="ui-rounded,'Arial Rounded MT Bold',sans-serif" font-size="21" font-weight="800">${currentStars}</text><text x="100" y="32" class="utility">STARS</text>
  </g>

  <g transform="translate(258 112)" filter="url(#handmade)">
    <rect width="114" height="48" rx="13" fill="${theme.tunnel}" stroke="#C68B3C"/>
    <circle cx="25" cy="24" r="13" fill="none" stroke="#C68B3C" stroke-width="2"/><path d="M18 24 H32 M25 17 V31" stroke="#C68B3C" stroke-width="1.5" opacity=".75"/>
    <text x="48" y="21" class="utility">BROWSER</text><text x="48" y="36" class="body">source</text>
  </g>
  <path d="M380 136 H580" stroke="${theme.border}" stroke-width="13" stroke-linecap="round"/><path d="M380 136 H580" stroke="url(#bridge-line)" stroke-width="3" stroke-dasharray="7 8" stroke-linecap="round"/>
  <g transform="translate(453 110)" filter="url(#handmade)"><rect width="54" height="52" rx="15" fill="${theme.panel}" stroke="#8E2735" stroke-width="1.5"/><path d="M17 25 V20 A10 10 0 0 1 37 20 V25 M14 25 H40 V42 H14Z" fill="none" stroke="#8E2735" stroke-width="2.5" stroke-linejoin="round"/><circle cx="27" cy="33" r="3" fill="#C68B3C"/><path d="M27 35 V39" stroke="#C68B3C" stroke-width="2"/></g>
  <g transform="translate(588 112)" filter="url(#handmade)">
    <rect width="114" height="48" rx="13" fill="${theme.tunnel}" stroke="#58A6FF"/>
    <path d="M15 15 H35 V33 H15Z M20 20 H30 M20 25 H30 M20 30 H26" fill="none" stroke="#58A6FF" stroke-width="1.7" stroke-linecap="round"/>
    <text x="48" y="21" class="utility">CODEX</text><text x="48" y="36" class="body">destination</text>
  </g>
  <text x="480" y="178" text-anchor="middle" class="utility">LOCAL · ENCRYPTED · VERIFIED</text>

  ${yGrid}${xLabels}
  <g clip-path="url(#plot)"><path d="${areaPath}" fill="url(#bridge-area)"/><path d="${linePath}" fill="none" stroke="${goldSoft}" stroke-width="9" opacity=".11"/><path d="${linePath}" fill="none" stroke="url(#bridge-line)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#handmade)"/></g>
  ${packets}
  <g transform="translate(${plot.right} ${currentY})" filter="url(#handmade)"><circle r="9" fill="#3DA639" stroke="${theme.panel}" stroke-width="3"/><path d="M-4 0 L-1 4 L5 -5" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g>

  <g transform="translate(60 459)" opacity=".82"><circle cx="9" cy="9" r="8" fill="none" stroke="#C68B3C" stroke-width="1.8"/><circle cx="6" cy="6" r="1.5" fill="#C68B3C"/><circle cx="12" cy="11" r="1.5" fill="#C68B3C"/><text x="27" y="14" class="body">cookies are credentials</text></g>
  <g transform="translate(736 458)" opacity=".82"><path d="M0 10 H73 M5 4 L0 10 L5 16 M68 4 L73 10 L68 16" fill="none" stroke="#58A6FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><text x="84" y="14" class="utility">YOUR MAC</text></g>
</svg>`;
}

export function niceMaximum(value) {
  if (value <= 5) return 5;
  if (value <= 10) return 10;
  if (value <= 20) return Math.ceil(value / 5) * 5;

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const step = magnitude * (fraction <= 1.25 ? 0.25 : 0.5);
  return Math.ceil(value / step) * step;
}

function smoothPath(points) {
  if (points.length === 0) return "";

  return points.reduce((path, [pointX, pointY], index) => {
    if (index === 0) return `M${pointX.toFixed(2)} ${pointY.toFixed(2)}`;
    const [previousX, previousY] = points[index - 1];
    const controlX = (previousX + pointX) / 2;
    return `${path} C${controlX.toFixed(2)} ${previousY.toFixed(2)} ${controlX.toFixed(2)} ${pointY.toFixed(2)} ${pointX.toFixed(2)} ${pointY.toFixed(2)}`;
  }, "");
}

function cumulativeSamples(stars, start, end, count) {
  let starIndex = 0;

  return dateTicks(start, end, count).map((timestamp) => {
    while (starIndex < stars.length && stars[starIndex] <= timestamp) {
      starIndex += 1;
    }
    return [timestamp, starIndex];
  });
}

function tickValues(maximum, count) {
  return Array.from({ length: count }, (_, index) =>
    Math.round((maximum / (count - 1)) * index),
  );
}

function dateTicks(start, end, count) {
  return Array.from(
    { length: count },
    (_, index) => start + ((end - start) / (count - 1)) * index,
  );
}

function formatDate(timestamp, range) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    ...(range >= 365 * ONE_DAY ? { year: "numeric" } : { day: "numeric" }),
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

function svgResponse(svg, cacheSeconds, status = 200) {
  return new Response(svg, {
    status,
    headers: {
      "Cache-Control": `public, max-age=3600, s-maxage=${cacheSeconds}, stale-if-error=86400`,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function renderErrorSvg(themeName) {
  const theme = THEMES[themeName] ?? THEMES.light;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="180" viewBox="0 0 960 180" role="img" aria-label="Star history is temporarily unavailable"><rect x=".5" y=".5" width="959" height="179" rx="20" fill="${theme.background}" stroke="${theme.border}"/><text x="48" y="78" fill="${theme.text}" font-family="ui-rounded,'Arial Rounded MT Bold',sans-serif" font-size="24" font-weight="800">The bridge is refreshing</text><text x="48" y="116" fill="${theme.muted}" font-family="'Trebuchet MS',sans-serif" font-size="17">The cached star history will return shortly.</text></svg>`;
}
