import cors from "cors";
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";

const app = express();
const port = Number(process.env.PORT || 8081);
const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
const upstreamBaseUrl = process.env.PHIMAPI_BASE_URL || "https://phimapi.com";
const hhpandaBaseUrl = process.env.HHPANDA_BASE_URL || "https://hhpanda.st";
const hh3dBaseUrl = process.env.HH3D_BASE_URL || "https://hh3d.io";
const corsOrigins = (process.env.CORS_ORIGINS || clientUrl)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === "production";
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);

type WatchHistoryItem = {
  name: string;
  origin_name?: string;
  slug: string;
  poster_url?: string;
  thumb_url?: string;
  episodeName?: string;
  watchedAt: number;
};

const watchHistoryByIp = new Map<string, WatchHistoryItem[]>();

const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  limit: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { status: false, message: "Too many requests" },
});

type HhpandaTerm = {
  id: number;
  name: string;
  slug: string;
};

type HhpandaPost = {
  id: number;
  slug: string;
  link: string;
  date?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  excerpt?: { rendered?: string };
  categories?: number[];
  country?: number[];
  release?: number[];
  _embedded?: {
    "wp:featuredmedia"?: Array<{ source_url?: string }>;
    "wp:term"?: HhpandaTerm[][];
  };
  _halim_metabox_options?: {
    halim_movie_formality?: string;
    halim_movie_status?: string;
    halim_original_title?: string;
    halim_runtime?: string;
    halim_episode?: string;
    halim_quality?: string;
    halim_showtime_movies?: string;
  };
  yoast_head_json?: {
    description?: string;
  };
};

function stripHtml(value = "") {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8211;/g, "-")
    .replace(/&#8230;/g, "...")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value = "") {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function clientIp(request: express.Request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return (value?.split(",")[0]?.trim() || request.ip || request.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function normalizeHistoryItem(value: Partial<WatchHistoryItem>): WatchHistoryItem | null {
  const name = boundedString(value.name, 160);
  const slug = boundedString(value.slug, 160);
  if (!name || !slug || !/^[a-z0-9-]+$/i.test(slug)) return null;

  return {
    name,
    origin_name: boundedString(value.origin_name, 180),
    slug,
    poster_url: boundedString(value.poster_url, 600),
    thumb_url: boundedString(value.thumb_url, 600),
    episodeName: boundedString(value.episodeName, 120),
    watchedAt: Math.min(Number(value.watchedAt || Date.now()), Date.now()),
  };
}

function errorDetail(error: unknown) {
  if (isProduction) return undefined;
  return error instanceof Error ? error.message : "Unknown error";
}

function hhpandaUrl(path: string) {
  return new URL(path, hhpandaBaseUrl);
}

function hh3dUrl(path: string) {
  return new URL(path, hh3dBaseUrl);
}

async function fetchHhpandaJson<T>(path: string, params: Record<string, string | number | undefined> = {}) {
  const url = hhpandaUrl(path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  const result = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "web-phim-local-dev/0.1",
    },
  });

  if (!result.ok) {
    throw new Error(`HHPANDA returned ${result.status} for ${url.pathname}`);
  }

  return {
    data: (await result.json()) as T,
    total: Number(result.headers.get("x-wp-total") || 0),
    totalPages: Number(result.headers.get("x-wp-totalpages") || 0),
  };
}

async function fetchHhpandaText(pathOrUrl: string) {
  const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : hhpandaUrl(pathOrUrl);
  const result = await fetch(url, {
    headers: {
      accept: "text/html",
      "user-agent": "web-phim-local-dev/0.1",
    },
  });

  if (!result.ok) {
    throw new Error(`HHPANDA returned ${result.status} for ${url.pathname}`);
  }

  return result.text();
}

async function fetchHh3dText(pathOrUrl: string) {
  const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : hh3dUrl(pathOrUrl);
  const result = await fetch(url, {
    headers: {
      accept: "text/html",
      "user-agent": "web-phim-local-dev/0.1",
    },
  });

  if (!result.ok) {
    throw new Error(`HH3D returned ${result.status} for ${url.pathname}`);
  }

  return result.text();
}

function termsFromPost(post: HhpandaPost, taxonomy: string) {
  const terms = post._embedded?.["wp:term"]?.flat() || [];
  return terms
    .filter((term) => (term as HhpandaTerm & { taxonomy?: string }).taxonomy === taxonomy)
    .map((term) => ({
      _id: term.id,
      name: term.name,
      slug: term.slug,
    }));
}

function normalizeHhpandaPost(post: HhpandaPost) {
  const meta = post._halim_metabox_options || {};
  const featured = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
  const content = stripHtml(post.content?.rendered || post.excerpt?.rendered || post.yoast_head_json?.description || "");
  const releaseTerm = termsFromPost(post, "release")[0];
  const releaseYear = releaseTerm ? Number(releaseTerm.name) : undefined;

  return {
    _id: post.id,
    name: stripHtml(post.title?.rendered || "Chưa có tên"),
    origin_name: stripHtml(meta.halim_original_title || ""),
    slug: post.slug,
    poster_url: featured,
    thumb_url: featured,
    year: Number.isFinite(releaseYear) ? releaseYear : post.date ? new Date(post.date).getFullYear() : undefined,
    quality: meta.halim_quality || "HD",
    episode_current: stripHtml(meta.halim_episode || ""),
    content,
    type: meta.halim_movie_formality === "tv_series" ? "series" : "movie",
    status: meta.halim_movie_status,
    time: stripHtml(meta.halim_runtime || ""),
    lang: "Vietsub",
    category: termsFromPost(post, "category"),
    country: termsFromPost(post, "country"),
    source_url: post.link,
  };
}

function parseHhpandaEpisodes(html: string) {
  const found = new Map<string, { name: string; slug: string; link_embed: string; open_external: boolean }>();
  const linkRegex = /<a\b[^>]*href=["']([^"']*watch-[^"']+)["'][^>]*title=["']([^"']*)["'][^>]*>/gi;

  for (const match of html.matchAll(linkRegex)) {
    const rawHref = match[1];
    const title = stripHtml(match[2] || "");
    if (!title || title.toLowerCase().includes("xem ngay")) continue;

    const href = rawHref.startsWith("http") ? rawHref : String(hhpandaUrl(rawHref));
    const slug = href
      .split("/")
      .pop()
      ?.replace(/\.html$/i, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase();

    if (!slug || found.has(href)) continue;
    const serverLabel = slug.match(/sv\d+$/i)?.[0]?.toUpperCase();
    found.set(href, {
      name: serverLabel && !title.toUpperCase().includes(serverLabel) ? `${title} - ${serverLabel}` : title,
      slug,
      link_embed: href,
      open_external: true,
    });
  }

  return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name, "vi", { numeric: true }));
}

function hhpandaListResponse(posts: HhpandaPost[], page: number, total: number, totalPages: number) {
  return {
    status: true,
    source: "HHPANDA",
    items: posts.map(normalizeHhpandaPost),
    pagination: {
      totalItems: total || posts.length,
      totalItemsPerPage: posts.length,
      currentPage: page,
      totalPages: totalPages || 1,
    },
  };
}

function parseHhpandaShowtime(value = "") {
  const text = decodeHtml(stripHtml(value));
  const time = text.match(/vào\s*([0-9]{1,2}h(?:[0-9]{2})?)/i)?.[1] || "";
  const daysText = text
    .replace(/^.*?vào\s*[0-9]{1,2}h(?:[0-9]{2})?/i, "")
    .replace(/^[:\s,-]+/, "")
    .trim();
  const days = Array.from(daysText.matchAll(/Chủ Nhật|Thứ\s*[2-7]/gi)).map((match) =>
    match[0].replace(/\s+/g, " ").replace(/^thứ/i, "Thứ").replace(/^chủ nhật/i, "Chủ Nhật"),
  );

  return {
    text,
    time,
    days,
  };
}

function hhpandaScheduleResponse(posts: HhpandaPost[], page: number, total: number, totalPages: number) {
  const items = posts
    .map((post) => {
      const showtime = parseHhpandaShowtime(post._halim_metabox_options?.halim_showtime_movies || "");

      return {
        _id: post.id,
        name: decodeHtml(stripHtml(post.title?.rendered || "")),
        slug: post.slug,
        time: showtime.time,
        days: showtime.days,
        showtime: showtime.text,
      };
    })
    .filter((item) => item.showtime);
  const byDay = items.reduce<Record<string, typeof items>>((result, item) => {
    const days = item.days.length ? item.days : ["Chưa rõ"];
    for (const day of days) {
      result[day] = [...(result[day] || []), item];
    }
    return result;
  }, {});

  return {
    status: true,
    source: "HHPANDA",
    items,
    byDay,
    pagination: {
      totalItems: total || posts.length,
      totalItemsPerPage: posts.length,
      currentPage: page,
      totalPages: totalPages || 1,
    },
  };
}

function slugFromHh3dUrl(url: string) {
  const pathname = new URL(url).pathname;
  return pathname.split("/").filter(Boolean)[0] || "";
}

function parseHh3dMovies(html: string, limit = 24) {
  const found = new Map<string, ReturnType<typeof normalizeHh3dCard>>();
  const cardRegex = /<div class="flw-item">([\s\S]*?)(?=<div class="flw-item">|<\/div>\s*<\/div>\s*<\/section>|<div class="clearfix"><\/div>\s*<\/div>)/gi;

  for (const cardMatch of html.matchAll(cardRegex)) {
    const movie = normalizeHh3dCard(cardMatch[1]);
    if (movie?.slug && !found.has(movie.slug)) {
      found.set(movie.slug, movie);
      if (found.size >= limit) break;
    }
  }

  if (found.size === 0) {
    const fallbackRegex =
      /<img[^>]+(?:src|data-src)="([^"]+)"[^>]+(?:alt|title)="([^"]+)"[\s\S]*?<a[^>]+class="film-poster-ahref"[^>]+href="(https:\/\/hh3d\.io\/[^"]+)"/gi;
    for (const match of html.matchAll(fallbackRegex)) {
      const slug = slugFromHh3dUrl(match[3]);
      if (!slug || found.has(slug)) continue;
      found.set(slug, {
        _id: slug,
        name: decodeHtml(match[2]),
        origin_name: "",
        slug,
        poster_url: match[1],
        thumb_url: match[1],
        quality: "Vietsub",
        episode_current: "",
        type: "series",
        status: "ongoing",
        lang: "Vietsub",
        source_url: match[3],
      });
      if (found.size >= limit) break;
    }
  }

  return Array.from(found.values());
}

function normalizeHh3dCard(card: string) {
  const href = card.match(/<a[^>]+class="film-poster-ahref"[^>]+href="(https:\/\/hh3d\.io\/[^"]+)"/i)?.[1];
  const title =
    card.match(/<a[^>]+class="dynamic-name"[^>]+title="([^"]+)"/i)?.[1] ||
    card.match(/<a[^>]+class="film-poster-ahref"[^>]+title="([^"]+)"/i)?.[1] ||
    card.match(/<img[^>]+alt="([^"]+)"/i)?.[1];
  const image = card.match(/<img[^>]+(?:src|data-src)="([^"]+)"/i)?.[1];
  const episode = stripHtml(card.match(/<div class="tick tick-rate">([\s\S]*?)<\/div>/i)?.[1] || "");

  if (!href || !title) return null;
  const slug = slugFromHh3dUrl(href);
  if (!slug) return null;

  return {
    _id: slug,
    name: decodeHtml(title),
    origin_name: "",
    slug,
    poster_url: image,
    thumb_url: image,
    quality: episode.includes("4K") ? "4K" : episode.includes("3D") ? "3D" : "HD",
    episode_current: episode,
    type: "series",
    status: "ongoing",
    lang: "Vietsub",
    source_url: href,
  };
}

function parseHh3dCategories(html?: string) {
  const fallback = [
    { _id: 1, name: "Mới cập nhật", slug: "moi-cap-nhat" },
    { _id: 2, name: "Hoạt hình 3D", slug: "hoat-hinh-3d" },
    { _id: 3, name: "Hoạt hình 2D", slug: "hoat-hinh-2d" },
    { _id: 4, name: "Hoạt hình 4K", slug: "hoat-hinh-4k" },
    { _id: 5, name: "Đang chiếu", slug: "dang-chieu" },
    { _id: 6, name: "Đã hoàn thành", slug: "da-hoan-thanh" },
    { _id: 7, name: "Huyền Huyễn", slug: "huyen-huyen" },
    { _id: 8, name: "Tiên Hiệp", slug: "tien-hiep" },
    { _id: 9, name: "Cổ Trang", slug: "co-trang" },
    { _id: 10, name: "Kiếm Hiệp", slug: "kiem-hiep" },
    { _id: 11, name: "Xuyên Không", slug: "xuyen-khong" },
  ];

  if (!html) return fallback;
  const found = new Map<string, { _id: number; name: string; slug: string }>();
  const regex = /href="https:\/\/hh3d\.io\/the-loai\/([^"]+)"[^>]*title="([^"]+)"/gi;
  for (const match of html.matchAll(regex)) {
    if (!found.has(match[1])) {
      found.set(match[1], { _id: found.size + 1, slug: match[1], name: decodeHtml(match[2]) });
    }
  }

  return found.size ? Array.from(found.values()) : fallback;
}

function parseHh3dDetail(html: string, slug: string) {
  const title =
    html.match(/<h2 class="film-name dynamic-name"[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ||
    html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1] ||
    slug;
  const image = html.match(/<meta property="og:image" content="([^"]+)"/i)?.[1];
  const description =
    html.match(/<div class="film-description[\s\S]*?<div class="text">([\s\S]*?)<span class="btn-more-desc/i)?.[1] ||
    html.match(/<meta name="description" content="([^"]+)"/i)?.[1] ||
    "";
  const time = stripHtml(html.match(/<span class="item-head">Thời lượng:\s*<\/span>\s*<span class="name">([\s\S]*?)<\/span>/i)?.[1] || "");
  const status = stripHtml(html.match(/<span class="item-head">Trạng thái:\s*<\/span>\s*<span class="name">([\s\S]*?)<\/span>/i)?.[1] || "");
  const latest = stripHtml(html.match(/<span class="item-head">Tập mới nhất:\s*<\/span>\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "");
  const categories = Array.from(html.matchAll(/<a class="name genre"\s+href="https:\/\/hh3d\.io\/the-loai\/([^"]+)">([\s\S]*?)<\/a>/gi)).map(
    (match, index) => ({
      _id: index + 1,
      slug: match[1],
      name: decodeHtml(stripHtml(match[2])),
    }),
  );

  return {
    _id: slug,
    name: decodeHtml(stripHtml(title)),
    origin_name: "",
    slug,
    poster_url: image,
    thumb_url: image,
    quality: "HD",
    episode_current: latest || time,
    content: decodeHtml(stripHtml(description)),
    type: "series",
    status: status || "ongoing",
    time,
    lang: "Vietsub",
    category: categories,
    country: [{ _id: 1, name: "Trung Quốc", slug: "trung-quoc" }],
    source_url: String(hh3dUrl(`/${slug}`)),
  };
}

function parseHh3dWatchLinks(html: string) {
  const found = new Map<string, { name: string; slug: string; link_embed: string }>();
  const regex = /<a\b[^>]+href="(https:\/\/hh3d\.io\/[^"]+\/(?:sub|voice)\/[^"]+)"[\s\S]*?<\/a>/gi;

  for (const match of html.matchAll(regex)) {
    const href = match[1];
    const pathParts = new URL(href).pathname.split("/").filter(Boolean);
    const mode = pathParts[pathParts.length - 2];
    if (mode !== "sub") continue;
    const episodeNumber = pathParts[pathParts.length - 1]?.split("-").pop() || "";
    const slug = `tap-${episodeNumber}`;
    if (!episodeNumber || found.has(slug)) continue;

    found.set(slug, {
      name: `Tập ${episodeNumber}`,
      slug,
      link_embed: href,
    });
  }

  return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name, "vi", { numeric: true }));
}

function firstHh3dSubLink(html: string) {
  return html.match(/href="(https:\/\/hh3d\.io\/[^"]+\/sub\/[^"]+)"/i)?.[1];
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(
  cors({
    origin: corsOrigins,
  }),
);
app.use("/api", apiLimiter);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "64kb" }));
app.use(morgan("dev"));

app.get("/api/health", (_request, response) => {
  response.json({
    status: "ok",
    service: "web_phim_backend",
    port,
    upstream: upstreamBaseUrl,
    hhpanda: hhpandaBaseUrl,
    hh3d: hh3dBaseUrl,
  });
});

app.get("/api/watch-history", (request, response) => {
  const key = clientIp(request);
  response.json({
    status: true,
    key,
    items: watchHistoryByIp.get(key) || [],
  });
});

app.post("/api/watch-history", (request, response) => {
  const key = clientIp(request);
  const item = normalizeHistoryItem(request.body || {});

  if (!item) {
    response.status(400).json({ status: false, message: "Invalid watch history item" });
    return;
  }

  const current = watchHistoryByIp.get(key) || [];
  const next = [item, ...current.filter((historyItem) => historyItem.slug !== item.slug)].slice(0, 12);
  watchHistoryByIp.set(key, next);

  response.json({
    status: true,
    key,
    items: next,
  });
});

app.delete("/api/watch-history", (request, response) => {
  const key = clientIp(request);
  watchHistoryByIp.delete(key);
  response.json({
    status: true,
    key,
    items: [],
  });
});

app.get("/api/hh3d/phim-moi-cap-nhat", async (request, response) => {
  const page = Number(request.query.page || 1);
  const limit = Number(request.query.limit || 24);

  try {
    const path = page > 1 ? `/the-loai/moi-cap-nhat?page=${page}` : "/";
    const html = await fetchHh3dText(path);
    const items = parseHh3dMovies(html, limit);

    response.json({
      status: true,
      source: "HH3D",
      items,
      pagination: {
        totalItems: items.length,
        totalItemsPerPage: items.length,
        currentPage: page,
        totalPages: 1,
      },
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HH3D latest movies",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/hh3d/tim-kiem", async (request, response) => {
  const keyword = String(request.query.keyword || "").trim();

  if (!keyword) {
    response.json({ status: true, source: "HH3D", items: [] });
    return;
  }

  try {
    const url = hh3dUrl("/");
    url.searchParams.set("keysearch", keyword);
    const html = await fetchHh3dText(String(url));
    response.json({
      status: true,
      source: "HH3D",
      items: parseHh3dMovies(html, Number(request.query.limit || 24)),
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot search HH3D",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/hh3d/the-loai", async (_request, response) => {
  try {
    const html = await fetchHh3dText("/");
    response.json(parseHh3dCategories(html));
  } catch {
    response.json(parseHh3dCategories());
  }
});

app.get("/api/hh3d/the-loai/:slug", async (request, response) => {
  const page = Number(request.query.page || 1);
  const limit = Number(request.query.limit || 24);

  try {
    const path = `/the-loai/${request.params.slug}${page > 1 ? `?page=${page}` : ""}`;
    const html = await fetchHh3dText(path);
    const items = parseHh3dMovies(html, limit);

    response.json({
      status: true,
      source: "HH3D",
      items,
      pagination: {
        totalItems: items.length,
        totalItemsPerPage: items.length,
        currentPage: page,
        totalPages: 1,
      },
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HH3D category",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/hh3d/quoc-gia", (_request, response) => {
  response.json([{ _id: 1, name: "Trung Quốc", slug: "trung-quoc" }]);
});

app.get("/api/hh3d/phim/:slug", async (request, response) => {
  try {
    const detailHtml = await fetchHh3dText(`/${request.params.slug}`);
    const movie = parseHh3dDetail(detailHtml, request.params.slug);
    const subLink = firstHh3dSubLink(detailHtml);
    const watchHtml = subLink ? await fetchHh3dText(subLink) : detailHtml;
    const episodes = parseHh3dWatchLinks(watchHtml);
    const serverData =
      episodes.length > 0
        ? episodes
        : subLink
          ? [{ name: "Tập mới nhất", slug: "tap-moi-nhat", link_embed: subLink }]
          : [];

    response.json({
      status: true,
      source: "HH3D",
      movie,
      episodes: [
        {
          server_name: "HH3D Vietsub",
          server_data: serverData,
        },
      ],
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HH3D movie detail",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/hhpanda/phim-moi-cap-nhat", async (request, response) => {
  const page = Number(request.query.page || 1);

  try {
    const result = await fetchHhpandaJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 24),
      _embed: 1,
    });

    response.json(hhpandaListResponse(result.data, page, result.total, result.totalPages));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHPANDA latest movies",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/hhpanda/tim-kiem", async (request, response) => {
  const page = Number(request.query.page || 1);
  const keyword = String(request.query.keyword || "").trim();

  if (!keyword) {
    response.json(hhpandaListResponse([], page, 0, 0));
    return;
  }

  try {
    const result = await fetchHhpandaJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 24),
      search: keyword,
      _embed: 1,
    });

    response.json(hhpandaListResponse(result.data, page, result.total, result.totalPages));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot search HHPANDA",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/hhpanda/the-loai", async (_request, response) => {
  try {
    const result = await fetchHhpandaJson<HhpandaTerm[]>("/wp-json/wp/v2/categories", {
      per_page: 100,
    });

    response.json(result.data.map((item) => ({ _id: item.id, name: item.name, slug: item.slug })));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHPANDA categories",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/hhpanda/quoc-gia", async (_request, response) => {
  try {
    const result = await fetchHhpandaJson<HhpandaTerm[]>("/wp-json/wp/v2/country", {
      per_page: 100,
    });

    response.json(result.data.map((item) => ({ _id: item.id, name: item.name, slug: item.slug })));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHPANDA countries",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/hhpanda/lich-chieu", async (request, response) => {
  const page = Number(request.query.page || 1);

  try {
    const result = await fetchHhpandaJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 100),
      _fields: "id,title,slug,_halim_metabox_options",
    });

    response.json(hhpandaScheduleResponse(result.data, page, result.total, result.totalPages));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHPANDA schedule",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/hhpanda/phim/:slug", async (request, response) => {
  try {
    const result = await fetchHhpandaJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      slug: request.params.slug,
      _embed: 1,
    });
    const post = result.data[0];

    if (!post) {
      response.status(404).json({ status: false, message: "Không tìm thấy phim trên HHPANDA" });
      return;
    }

    const detailHtml = await fetchHhpandaText(post.link);
    const episodes = parseHhpandaEpisodes(detailHtml);

    response.json({
      status: true,
      source: "HHPANDA",
      movie: normalizeHhpandaPost(post),
      episodes: [
        {
          server_name: "HHPANDA",
          server_data: episodes,
        },
      ],
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHPANDA movie detail",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/*", async (request, response) => {
  const path = (request.params as unknown as Record<string, string>)["0"];
  const upstream = new URL(`${upstreamBaseUrl}/${path}`);

  for (const [key, value] of Object.entries(request.query)) {
    if (Array.isArray(value)) {
      value.forEach((item) => upstream.searchParams.append(key, String(item)));
    } else if (value !== undefined) {
      upstream.searchParams.set(key, String(value));
    }
  }

  try {
    const upstreamResponse = await fetch(upstream, {
      headers: {
        accept: "application/json",
        "user-agent": "web-phim-local-dev/0.1",
      },
    });

    const contentType = upstreamResponse.headers.get("content-type") || "application/json";
    response.status(upstreamResponse.status).type(contentType);

    if (contentType.includes("application/json")) {
      response.json(await upstreamResponse.json());
      return;
    }

    response.send(await upstreamResponse.text());
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot reach upstream movie API",
      detail: errorDetail(error),
    });
  }
});

export default app;

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Backend proxy listening on http://localhost:${port}`);
  });
}
