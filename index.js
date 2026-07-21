const express = require("express");
const dotenv = require("dotenv");
const crypto = require("crypto");
const sharp = require("sharp");

dotenv.config();

const {
    PORT = 3000,
    APP_BASE_URL,
    SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET,
    SPOTIFY_REFRESH_TOKEN,
    RENDER_API_KEY,
    RENDER_SERVICE_ID,
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !APP_BASE_URL) {
    console.error("Missing env vars. Check SPOTIFY_CLIENT_ID/SECRET and APP_BASE_URL.");
    process.exit(1);
}

const app = express();

const SCOPES = ["user-read-currently-playing", "user-read-playback-state"].join(" ");
const COVER_CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_IMAGE_URL = "https://raw.githubusercontent.com/tanoojoy/tanoojoy/refs/heads/main/sleepybara.png";
const coverCache = new Map();
let spotifyRefreshToken = SPOTIFY_REFRESH_TOKEN;
let accessTokenCache = null;
let accessTokenPromise = null;

function parseCookies(req) {
    return Object.fromEntries(
        String(req.headers.cookie || "")
            .split(";")
            .map(part => part.trim().split(/=(.*)/s))
            .filter(([key]) => key)
            .map(([key, value]) => [key, decodeURIComponent(value || "")])
    );
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a || ""));
    const right = Buffer.from(String(b || ""));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function toBasicAuth(id, secret) {
    return Buffer.from(`${id}:${secret}`).toString("base64");
}

async function exchangeCodeForTokens(code) {
    const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${APP_BASE_URL}/callback`,
    });

    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${toBasicAuth(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET)}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });

    if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
    return res.json();
}

async function getAccessTokenViaRefreshToken(refreshToken) {
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
    });

    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${toBasicAuth(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET)}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });

    if (!res.ok) throw new Error(`Refresh token failed: ${res.status} ${await res.text()}`);
    return res.json();
}

async function renderApi(path, options = {}) {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
        throw new Error("Missing RENDER_API_KEY or RENDER_SERVICE_ID");
    }

    const res = await fetch(`https://api.render.com/v1/services/${encodeURIComponent(RENDER_SERVICE_ID)}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${RENDER_API_KEY}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            ...options.headers,
        },
    });

    if (!res.ok) {
        throw new Error(`Render API failed: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
}

async function saveRefreshTokenOnRender(refreshToken) {
    await renderApi("/env-vars/SPOTIFY_REFRESH_TOKEN", {
        method: "PUT",
        body: JSON.stringify({ value: refreshToken }),
    });
    await renderApi("/deploys", {
        method: "POST",
        body: JSON.stringify({ clearCache: "do_not_clear" }),
    });
}

async function getSpotifyAccessToken() {
    if (accessTokenCache && Date.now() < accessTokenCache.expiresAt) {
        return accessTokenCache.value;
    }
    if (accessTokenPromise) return accessTokenPromise;

    accessTokenPromise = (async () => {
        if (!spotifyRefreshToken) {
            throw new Error("Spotify authorization required. Visit /login.");
        }

        const tokens = await getAccessTokenViaRefreshToken(spotifyRefreshToken);
        if (tokens.refresh_token && tokens.refresh_token !== spotifyRefreshToken) {
            spotifyRefreshToken = tokens.refresh_token;
            await saveRefreshTokenOnRender(spotifyRefreshToken);
        }

        accessTokenCache = {
            value: tokens.access_token,
            // Refresh a minute early to avoid using a token near expiration.
            expiresAt: Date.now() + Math.max(60, (tokens.expires_in || 3600) - 60) * 1000,
        };
        return accessTokenCache.value;
    })();

    try {
        return await accessTokenPromise;
    } finally {
        accessTokenPromise = null;
    }
}

async function fetchCurrentlyPlaying(accessToken) {
    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode", {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 204) return null;
    if (res.status === 200) return res.json();

    const txt = await res.text();
    throw new Error(`Spotify API error ${res.status}: ${txt}`);
}

function esc(text = "") {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function msToClock(ms = 0) {
    if (!ms || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function cacheGet(url) {
    const v = coverCache.get(url);
    if (!v) return null;
    if (Date.now() - v.t > COVER_CACHE_TTL_MS) {
        coverCache.delete(url);
        return null;
    }
    return v.dataUri;
}
function cacheSet(url, dataUri) {
    coverCache.set(url, { dataUri, t: Date.now() });
}

async function urlToDataUri(url) {
    url ||= FALLBACK_IMAGE_URL;
    const cached = cacheGet(url);
    if (cached) return cached;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`image fetch ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const compactImage = await sharp(buf, { limitInputPixels: 25_000_000 })
            .rotate()
            .resize(320, 320, { fit: "cover" })
            .jpeg({ quality: 72 })
            .toBuffer();
        const dataUri = `data:image/jpeg;base64,${compactImage.toString("base64")}`;
        cacheSet(url, dataUri);
        return dataUri;
    } catch {
        return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAGswJ/lk8mOQAAAABJRU5ErkJggg==";
    }
}

async function getNowPlayingPayload() {
    const access_token = await getSpotifyAccessToken();
    const data = await fetchCurrentlyPlaying(access_token);

    if (!data || !data.item) return { isPlaying: false };

    const isPlaying = Boolean(data.is_playing);
    const item = data.item;

    const title = item.name || "";
    const album = item.album?.name || "";
    const artists = (item.artists || []).map(a => a.name);
    const explicit = !!item.explicit;
    const trackUrl = item.external_urls?.spotify || "";
    const coverUrl = item.album?.images?.[0]?.url || "";
    const imageUrl = isPlaying ? await urlToDataUri(coverUrl) : await urlToDataUri(false);
    const durationMs = item.duration_ms ?? 0;

    const progressMsRaw = data.progress_ms ?? 0;
    const spotifyTs = data.timestamp ?? Date.now();
    const now = Date.now();
    const clockSkew = Math.abs(now - spotifyTs);
    const correction = clockSkew < 2000 ? (now - spotifyTs) : 0;
    const progressAtRender = Math.min(durationMs, Math.max(0, progressMsRaw + correction));
    const remainingMs = Math.max(0, durationMs - progressAtRender);

    return {
        isPlaying,
        title,
        album,
        artists,
        explicit,
        trackUrl,
        imageUrl,
        durationMs,
        progressMs: progressAtRender,
        remainingMs,
        accent: "#1db954",
    };
}

function renderSVG(opts) {
    const {
        title = "—",
        album = "—",
        artists = [],
        explicit = false,
        trackUrl = "",
        imageUrl,
        progressMs = 0,
        durationMs = 0,
        remainingMs = 0,
        isPlaying = false,
        accent = "#1db954",
        theme = "dark",
        size = "wide",
        statusLabel,
    } = opts;


    const isCompact = size === "compact";
    const r = 16;
    const padding = 16;

    const artSize = isCompact ? 180 : 200;
    const height = artSize;
    const leftW = artSize;
    const txtX = leftW + padding;
    const width = leftW + 320;
    const contentW = width - txtX - padding;
    const labelText = statusLabel || (isPlaying ? "Now Playing" : "Not Playing");

    const colors = theme === "light" ? {
        card: "#ffffff",
        stroke: "#e5e7eb",
        text: "#0f172a",
        muted: "#475569",
        barBg: "#e5e7eb",
        backdropOpacity: 0.08
    } : {
        card: "#0d1117",
        stroke: "#30363d",
        text: "#c9d1d9",
        muted: "#8b949e",
        barBg: "#30363d",
        backdropOpacity: 0.18
    };

    let artistsText = (artists || []).join(", ");
    isPlaying ? null : artistsText = "*cricket noises*";
    const pct = durationMs > 0 ? Math.max(0, Math.min(1, progressMs / durationMs)) : 0;
    const filled = Math.round(contentW * pct);
    const animateTag = (isPlaying && remainingMs > 500 && filled <= contentW)
        ? `<animate attributeName="width"
                from="${filled}" to="${contentW}"
                dur="${(remainingMs / 1000).toFixed(2)}s"
                calcMode="linear" fill="freeze" />`
        : "";

    const linkOpen = trackUrl ? `<a xlink:href="${esc(trackUrl)}" target="_blank" rel="noopener noreferrer">` : "";
    const linkClose = trackUrl ? `</a>` : "";
    const eqY = padding + (isCompact ? 60 : 70);
    const eqW = 4, eqGap = 4, eqCount = 7;
    const eq = isPlaying ? `
    <g transform="translate(${txtX}, ${eqY})">
      ${Array.from({ length: eqCount }).map((_, i) => `
        <rect x="${i * (eqW + eqGap)}" y="0" width="${eqW}" height="14" fill="${accent}">
          <animate attributeName="height" values="5;18;9;20;7;14;5" dur="${(1 + i * 0.12).toFixed(2)}s" repeatCount="indefinite"/>
          <animate attributeName="y"      values="9;0;6;0;7;2;9"   dur="${(1 + i * 0.12).toFixed(2)}s" repeatCount="indefinite"/>
        </rect>
      `).join("")}
    </g>
  ` : "";

    const eBadge = explicit ? `
    <g transform="translate(${txtX - 24}, ${padding + 2})">
      <rect width="18" height="18" rx="4" ry="4" fill="#e11d48"></rect>
      <text x="9" y="13" text-anchor="middle" font-size="12" fill="#fff" font-family="Segoe UI, Helvetica, Arial, sans-serif">E</text>
    </g>` : "";


    const labelY = padding + 14;
    const titleY = padding + (isCompact ? 36 : 40);
    const artistY = padding + (isCompact ? 56 : 60);
    const barY = height - padding - 30;
    const timeY = height - padding - 8;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
     xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     role="img" aria-label="${esc(labelText)}: ${esc(title)}">
  <defs>
    <clipPath id="cardClip">
      <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${r}" ry="${r}" />
    </clipPath>
    <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="24"/>
    </filter>
  </defs>

  <g clip-path="url(#cardClip)">
    <image href="${esc(imageUrl)}" x="0" y="-60" width="${width}" height="${height + 120}"
           preserveAspectRatio="xMidYMid slice" filter="url(#blur)" opacity="${colors.backdropOpacity}"/>
  </g>

  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${r}" ry="${r}"
        fill="${colors.card}" stroke="${colors.stroke}"/>

  ${linkOpen}
    <g clip-path="url(#cardClip)">
      <image href="${esc(imageUrl)}" x="0" y="0" width="${leftW}" height="${height}"
             preserveAspectRatio="xMidYMid slice"/>
    </g>

    ${eBadge}
    <text x="${txtX}" y="${labelY}" font-size="12" font-weight="600"
          fill="${colors.muted}" font-family="Segoe UI, Helvetica, Arial, sans-serif">
      ${esc(isPlaying ? "Now Playing" : "Not Playing")}
    </text>

    <text x="${txtX}" y="${titleY}" font-size="${isCompact ? 18 : 20}" font-weight="700"
          fill="${colors.text}" font-family="Segoe UI, Helvetica, Arial, sans-serif">
      <title>${esc(title)}</title>${esc(title || "—")}
    </text>

    <text x="${txtX}" y="${artistY}" font-size="${isCompact ? 14 : 15}" font-weight="600"
          fill="${colors.muted}" font-family="Segoe UI, Helvetica, Arial, sans-serif">
      <title>${esc(artistsText || album || "—")}</title>${esc(artistsText || album || "—")}
    </text>
  ${linkClose}

  ${eq}

  <rect x="${txtX}" y="${barY}" width="${contentW}" height="10" fill="${colors.barBg}" rx="5" ry="5"/>
  <rect x="${txtX}" y="${barY}" width="${filled}" height="10" fill="${accent}" rx="5" ry="5">
    ${animateTag}
  </rect>

  <text x="${txtX}" y="${timeY}" font-size="12" fill="${colors.muted}" font-family="Segoe UI, Helvetica, Arial, sans-serif">
    ${msToClock(progressMs)} / ${msToClock(durationMs)}
  </text>
</svg>`;
}

app.get("/login", (req, res) => {
    const state = crypto.randomBytes(32).toString("base64url");
    const secureCookie = APP_BASE_URL.startsWith("https://") ? "; Secure" : "";
    const params = new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        response_type: "code",
        redirect_uri: `${APP_BASE_URL}/callback`,
        scope: SCOPES,
        state,
    });
    res.setHeader(
        "Set-Cookie",
        `spotify_oauth_state=${encodeURIComponent(state)}; HttpOnly${secureCookie}; SameSite=Lax; Path=/callback; Max-Age=600`
    );
    res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get("/callback", async (req, res) => {
    try {
        const secureCookie = APP_BASE_URL.startsWith("https://") ? "; Secure" : "";
        const expectedState = parseCookies(req).spotify_oauth_state;
        if (!expectedState || !safeEqual(req.query.state, expectedState)) {
            return res.status(400).send("Invalid or expired OAuth state. Start again at /login.");
        }
        res.setHeader(
            "Set-Cookie",
            `spotify_oauth_state=; HttpOnly${secureCookie}; SameSite=Lax; Path=/callback; Max-Age=0`
        );

        if (req.query.error) return res.status(400).send(`Spotify authorization failed: ${esc(req.query.error)}`);
        const code = req.query.code;
        if (!code) return res.status(400).send("Missing ?code");
        const tokens = await exchangeCodeForTokens(code);
        const refresh = tokens.refresh_token;
        if (!refresh) return res.status(500).send("No refresh_token returned. Check scopes.");
        spotifyRefreshToken = refresh;
        accessTokenCache = tokens.access_token
            ? {
                value: tokens.access_token,
                expiresAt: Date.now() + Math.max(60, (tokens.expires_in || 3600) - 60) * 1000,
            }
            : null;
        await saveRefreshTokenOnRender(refresh);
        res.send("<h2>Spotify reauthorized</h2><p>The refresh token was saved to Render and a deploy was started. You can close this page.</p>");
    } catch (e) {
        console.error("Spotify callback failed:", e);
        res.status(500).send(String(e));
    }
});

app.get("/now-playing.json", async (req, res) => {
    try {
        const payload = await getNowPlayingPayload();
        if (!payload.isPlaying) {
            return res.json({ isPlaying: false, status: "Not using Spotify" });
        }
        res.setHeader("Cache-Control", "no-cache");
        res.json(payload);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.get("/now-playing.svg", async (req, res) => {
    try {
        const theme = (req.query.theme || "dark").toLowerCase();
        const size = (req.query.size || "wide").toLowerCase();
        const payload = await getNowPlayingPayload();
        let svg;
        if (!payload.isPlaying) {
            svg = renderSVG({
                ...payload,
                title: "Not using Spotify",
                album: "*cricket noises*",
                imageUrl: await urlToDataUri(FALLBACK_IMAGE_URL),
                progressMs: 0,
                durationMs: 0,
                remainingMs: 0,
                statusLabel: "Not using Spotify",
                theme, size,
            });
        } else {
            svg = renderSVG({ ...payload, theme, size });
        }

        const etag = `"${crypto.createHash("sha1").update(svg).digest("hex")}"`;
        if (req.headers["if-none-match"] === etag) return res.status(304).end();

        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=0, s-maxage=0, must-revalidate");
        res.setHeader("ETag", etag);
        res.send(svg);
    } catch (e) {
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        res.status(200).send(`<svg width="500" height="80" xmlns="http://www.w3.org/2000/svg"><text x="10" y="40" fill="red">${esc(String(e))}</text></svg>`);
    }
});

app.get("/", (req, res) => {
    res.send(`<h1>Spotify Now Playing</h1><ul>
    <li><a href="/login">/login</a></li>
    <li><a href="/now-playing.json">/now-playing.json</a></li>
    <li><a href="/now-playing.svg">/now-playing.svg</a></li>
  </ul>`);
});

app.listen(PORT, () => {
    console.log(`Listening on ${APP_BASE_URL || `http://localhost:${PORT}`}`);
});
