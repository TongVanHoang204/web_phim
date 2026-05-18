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
const hhkungfuBaseUrl = process.env.HHKUNGFU_BASE_URL || "https://hhkungfu.ee";
const animehayBaseUrl = process.env.ANIMEHAY_BASE_URL || "https://animehay03.site";
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
  showtimes?: number[];
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

type HhkungfuSource = "hh3d" | "hhpanda";

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

function hhkungfuUrl(path: string) {
  return new URL(path, hhkungfuBaseUrl);
}

function animehayUrl(path: string) {
  return new URL(path, animehayBaseUrl);
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

async function fetchHhkungfuJson<T>(path: string, params: Record<string, string | number | undefined> = {}) {
  const url = hhkungfuUrl(path);
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
    throw new Error(`HHKUNGFU returned ${result.status} for ${url.pathname}`);
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

async function fetchHhkungfuText(pathOrUrl: string) {
  const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : hhkungfuUrl(pathOrUrl);
  const result = await fetch(url, {
    headers: {
      accept: "text/html",
      "user-agent": "web-phim-local-dev/0.1",
    },
  });

  if (!result.ok) {
    throw new Error(`HHKUNGFU returned ${result.status} for ${url.pathname}`);
  }

  return result.text();
}

async function fetchAnimehayText(pathOrUrl: string) {
  const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : animehayUrl(pathOrUrl);
  const result = await fetch(url, {
    headers: {
      accept: "text/html",
      "user-agent": "Mozilla/5.0 (compatible; TSVERSE/0.1)",
    },
  });

  if (!result.ok) {
    throw new Error(`AnimeHay returned ${result.status} for ${url.pathname}`);
  }

  return result.text();
}

async function fetchHhkungfuPlayerHtml(params: { postId: string; chapter: string; type: string; sv: string }) {
  const url = hhkungfuUrl("/player/player.php");
  url.searchParams.set("action", "dox_ajax_player");
  url.searchParams.set("post_id", params.postId);
  url.searchParams.set("chapter_st", params.chapter);
  url.searchParams.set("type", params.type);
  url.searchParams.set("sv", params.sv);

  const result = await fetch(url, {
    headers: {
      accept: "text/html",
      referer: hhkungfuBaseUrl,
      "x-requested-with": "XMLHttpRequest",
      "user-agent": "web-phim-local-dev/0.1",
    },
  });

  if (!result.ok) {
    throw new Error(`HHKUNGFU player returned ${result.status}`);
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

function hhkungfuSourceLabel(source: HhkungfuSource) {
  return source === "hh3d" ? "HHKUNGFU-HH3D" : "HHKUNGFU-HHPANDA";
}

function hhkungfuSourceFromRequest(request: express.Request): HhkungfuSource {
  return request.path.startsWith("/api/hh3d/") ? "hh3d" : "hhpanda";
}

function requestWantsAnimehay(request: express.Request) {
  return String(request.query.source || "").toLowerCase() === "animehay" || String(request.query.type || "").toLowerCase() === "japan";
}

function hhkungfuProxyPlayerUrl(postId: string, chapter: string, type: string, sv: string) {
  const url = new URL("/api/hhkungfu/player", clientUrl);
  url.searchParams.set("post_id", postId);
  url.searchParams.set("chapter_st", chapter);
  url.searchParams.set("type", type);
  url.searchParams.set("sv", sv);
  return `${url.pathname}${url.search}`;
}

function parseIframeSrc(html: string) {
  const src = html.match(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i)?.[1];
  if (!src) return "";
  try {
    return String(new URL(decodeHtml(src), hhkungfuBaseUrl));
  } catch {
    return "";
  }
}

function streamfreeProxyUrl(value: string) {
  if (!value) return "";
  const url = new URL(value);
  if (url.hostname !== "streamfree.vip") return value;
  return `/api/streamfree${url.pathname}${url.search}`;
}

function rewriteStreamfreeUrls(value: string) {
  return value
    .replace(/https?:\/\/streamfree\.vip\//g, "/api/streamfree/")
    .replace(/\/\/streamfree\.vip\//g, "/api/streamfree/")
    .replace(/https?:\\\/\\\/streamfree\.vip\\\//g, "\\/api\\/streamfree\\/")
    .replace(/\\\/\\\/streamfree\.vip\\\//g, "\\/api\\/streamfree\\/");
}

const streamfreeDetectorGuardJs =
  '!function(){try{var n=function(){};["clear","table","log","debug","info","warn","error","dir","trace"].forEach(function(k){try{console[k]=n}catch(e){}});var isNoise=function(u){u=String(u||"");return /ibyteimg\\.com\\/obj\\/ad-site-i18n|\\/cdn-cgi\\/rum/.test(u)};try{var of=window.fetch;if(of){window.fetch=function(i,o){var u=typeof i==="string"?i:i&&i.url;if(isNoise(u)){return Promise.resolve(new Response("",{status:204,statusText:"No Content"}))}return of.apply(this,arguments)}}}catch(e){}try{var O=XMLHttpRequest.prototype.open,S=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__tsverseNoise=isNoise(u);return O.apply(this,arguments)};XMLHttpRequest.prototype.send=function(){if(this.__tsverseNoise){var x=this;setTimeout(function(){try{Object.defineProperty(x,"readyState",{value:4,configurable:true});Object.defineProperty(x,"status",{value:204,configurable:true});Object.defineProperty(x,"statusText",{value:"No Content",configurable:true});Object.defineProperty(x,"responseText",{value:"",configurable:true});Object.defineProperty(x,"response",{value:"",configurable:true});x.onreadystatechange&&x.onreadystatechange(new Event("readystatechange"));x.onload&&x.onload(new Event("load"));x.onloadend&&x.onloadend(new Event("loadend"))}catch(e){}},0);return}return S.apply(this,arguments)}}catch(e){}var clean=function(v){return typeof v==="string"?v.replace(/\\bdebugger\\b/g,"void 0"):v};try{var nf=window.Function;window.Function=new Proxy(nf,{apply:function(t,a,r){return Reflect.apply(t,a,Array.prototype.map.call(r,clean))},construct:function(t,r){return Reflect.construct(t,Array.prototype.map.call(r,clean))}})}catch(e){}try{var ne=window.eval;window.eval=function(v){return ne.call(this,clean(v))}}catch(e){}var w=function(){return window.innerWidth},h=function(){return window.innerHeight};try{Object.defineProperty(window,"outerWidth",{get:w,configurable:true})}catch(e){}try{Object.defineProperty(window,"outerHeight",{get:h,configurable:true})}catch(e){}}catch(e){}}();';
const streamfreeDetectorGuard = '<script src="/streamfree-guard.js"></script>';

function neutralizeDebuggerScript(value: string) {
  return value.replace(/\bdebugger\b/g, "void 0");
}

function encodeEpisodeId(postId: string, chapter: string, type: string, sv: string) {
  return Buffer.from(JSON.stringify({ postId, chapter, type, sv }), "utf8").toString("base64url");
}

function decodeEpisodeId(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<{
      postId: string;
      chapter: string;
      type: string;
      sv: string;
    }>;
    if (!parsed.postId || !parsed.chapter || !parsed.type || !parsed.sv) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hhkungfuEpisodeItem(episode: { name: string; slug: string; postId: string; chapter: string; sv: string; sourceUrl?: string }, type: string) {
  return {
    _id: encodeEpisodeId(episode.postId, episode.chapter, type, episode.sv),
    name: episode.name,
    slug: episode.slug,
    link_embed: hhkungfuProxyPlayerUrl(episode.postId, episode.chapter, type, episode.sv),
    source_url: episode.sourceUrl,
    open_external: false,
  };
}

function normalizeHhkungfuPost(post: HhpandaPost) {
  const featured = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
  const content = stripHtml(post.content?.rendered || post.excerpt?.rendered || post.yoast_head_json?.description || "");
  const releaseTerm = termsFromPost(post, "release")[0];
  const statusTerm = termsFromPost(post, "status")[0];
  const releaseYear = releaseTerm ? Number(releaseTerm.name) : undefined;

  return {
    _id: post.id,
    name: decodeHtml(stripHtml(post.title?.rendered || "Chưa có tên")),
    origin_name: "",
    slug: post.slug,
    poster_url: featured,
    thumb_url: featured,
    year: Number.isFinite(releaseYear) ? releaseYear : post.date ? new Date(post.date).getFullYear() : undefined,
    quality: "HD",
    episode_current: "",
    content: decodeHtml(content),
    type: "series",
    status: statusTerm?.slug || "ongoing",
    time: "",
    lang: "Vietsub",
    category: termsFromPost(post, "category"),
    country: termsFromPost(post, "country"),
    source_url: post.link,
  };
}

function parseHhkungfuPlayerServers(html: string) {
  const found = new Map<string, { type: string; name: string }>();
  const regex = /<span\b[^>]*class=["'][^"']*\bget-eps\b[^"']*["'][^>]*data-type=["']([^"']+)["'][^>]*>([\s\S]*?)<\/span>/gi;

  for (const match of html.matchAll(regex)) {
    const type = match[1];
    const name = stripHtml(match[2]) || type.toUpperCase();
    if (!found.has(type)) found.set(type, { type, name: decodeHtml(name) });
  }

  if (!found.size) found.set("pro", { type: "pro", name: "HHKUNGFU" });
  return Array.from(found.values());
}

function parseHhkungfuEpisodes(html: string) {
  const episodes = new Map<string, { name: string; slug: string; postId: string; chapter: string; sv: string; sourceUrl: string }>();
  const regex =
    /<a\b[^>]*data-post-id=["']([^"']+)["'][^>]*data-ep=["']([^"']+)["'][^>]*data-sv=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*title=["']([^"']*)["'][^>]*>/gi;

  for (const match of html.matchAll(regex)) {
    const postId = match[1];
    const chapter = match[2];
    const sv = match[3] || "1";
    const sourceUrl = String(hhkungfuUrl(match[4] || "/"));
    const title = decodeHtml(stripHtml(match[5] || chapter));
    const slug = chapter
      .replace(/\.html$/i, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase();

    if (!postId || !chapter || !slug || episodes.has(slug)) continue;
    episodes.set(slug, {
      name: title || slug,
      slug,
      postId,
      chapter,
      sv,
      sourceUrl,
    });
  }

  return Array.from(episodes.values()).sort((a, b) => a.name.localeCompare(b.name, "vi", { numeric: true }));
}

function hhkungfuEpisodeServers(html: string) {
  const servers = parseHhkungfuPlayerServers(html);
  const episodes = parseHhkungfuEpisodes(html);

  return servers.map((server) => ({
    server_name: server.name,
    server_data: episodes.map((episode) => hhkungfuEpisodeItem(episode, server.type)),
  }));
}

function hhkungfuListResponse(source: HhkungfuSource, posts: HhpandaPost[], page: number, total: number, totalPages: number) {
  return {
    status: true,
    source: hhkungfuSourceLabel(source),
    items: posts.map(normalizeHhkungfuPost),
    pagination: {
      totalItems: total || posts.length,
      totalItemsPerPage: posts.length,
      currentPage: page,
      totalPages: totalPages || 1,
    },
  };
}

function slugFromHhkungfuUrl(url: string) {
  const pathname = new URL(url).pathname;
  return pathname.split("/").filter(Boolean)[0] || "";
}

function hhkungfuLatestPagePath(page: number) {
  return page > 1 ? `/moi-cap-nhat/page/${page}` : "/moi-cap-nhat";
}

function hhkungfuPopularPagePath(page: number) {
  return page > 1 ? `/top-xem-nhieu/page/${page}` : "/top-xem-nhieu";
}

function parseHhkungfuPagination(html: string, currentPage: number, itemCount: number) {
  const pages = Array.from(html.matchAll(/class=["'][^"']*page-numbers[^"']*["'][^>]*>(\d+)<\/a>/gi))
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const totalPages = Math.max(currentPage, ...pages, 1);

  return {
    totalItems: totalPages * itemCount,
    totalItemsPerPage: itemCount,
    currentPage,
    totalPages,
  };
}

function parseHhkungfuLatestMovies(html: string, limit = 24) {
  const sectionStart = html.search(/<span>\s*Mới cập nhật\s*<\/span>/i);
  const source = sectionStart >= 0 ? html.slice(sectionStart) : html;
  const sectionEnd = source.search(/<section\b[^>]*class=["'][^"']*hot-movies/i);
  const section = sectionEnd >= 0 ? source.slice(0, sectionEnd) : source;
  const found = new Map<string, ReturnType<typeof normalizeHhkungfuLatestCard>>();
  const cardRegex = /<article\b[^>]*class=["'][^"']*\bpost-(\d+)\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;

  for (const match of section.matchAll(cardRegex)) {
    const movie = normalizeHhkungfuLatestCard(match[1], match[2]);
    if (movie?.slug && !found.has(movie.slug)) {
      found.set(movie.slug, movie);
      if (found.size >= limit) break;
    }
  }

  return Array.from(found.values());
}

function normalizeHhkungfuLatestCard(postId: string, card: string) {
  const href = card.match(/<a\b[^>]*class=["'][^"']*\bhalim-thumb\b[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1];
  const title =
    card.match(/<h2\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1] ||
    card.match(/<a\b[^>]*title=["']([^"']+)["']/i)?.[1] ||
    card.match(/<img\b[^>]*alt=["']([^"']+)["']/i)?.[1];
  const originTitle = card.match(/<p\b[^>]*class=["'][^"']*\boriginal_title\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
  const image = card.match(/<img\b[^>]*(?:src|data-src)=["']([^"']+)["']/i)?.[1];
  const quality = stripHtml(card.match(/<span\b[^>]*class=["'][^"']*\bstatus\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "HD");
  const episode = stripHtml(card.match(/<span\b[^>]*class=["'][^"']*\bepisode\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");

  if (!href || !title) return null;
  const slug = slugFromHhkungfuUrl(href.startsWith("http") ? href : String(hhkungfuUrl(href)));
  if (!slug) return null;

  return {
    _id: Number(postId),
    name: decodeHtml(stripHtml(title)),
    origin_name: decodeHtml(stripHtml(originTitle)),
    slug,
    poster_url: image,
    thumb_url: image,
    year: undefined,
    quality,
    episode_current: decodeHtml(episode),
    content: "",
    type: "series",
    status: "ongoing",
    time: "",
    lang: "Vietsub",
    category: [],
    country: [{ _id: 1, name: "Trung Quốc", slug: "trung-quoc" }],
    source_url: href,
  };
}

function hhkungfuLatestResponse(items: ReturnType<typeof parseHhkungfuLatestMovies>, html: string, page: number) {
  return {
    status: true,
    source: "HHKUNGFU",
    items,
    pagination: parseHhkungfuPagination(html, page, items.length),
  };
}

function animehayLatestPagePath(page: number) {
  return `/phim-moi-cap-nhap/tat-ca-${page}.html`;
}

function animehayInternalSlug(rawSlug: string, movieId: string | number) {
  return `animehay-${movieId}-${rawSlug}`;
}

function parseAnimehayInternalSlug(value: string) {
  const match = value.match(/^animehay-(\d+)-(.+)$/i);
  if (!match) return null;
  return { movieId: match[1], rawSlug: match[2] };
}

function animehayCategorySlug(rawSlug: string, categoryId: string | number) {
  return `animehay-${categoryId}-${rawSlug}`;
}

function parseAnimehayCategorySlug(value: string) {
  const match = value.match(/^animehay-(\d+)-(.+)$/i);
  if (!match) return null;
  return { categoryId: match[1], rawSlug: match[2] };
}

function animehayAbsoluteUrl(value = "") {
  if (!value) return "";
  return value.startsWith("http") ? value.replace(/([^:]\/)\/+/g, "$1") : String(animehayUrl(value)).replace(/([^:]\/)\/+/g, "$1");
}

function animehayWatchPathFromUrl(value: string) {
  const url = value.startsWith("http") ? new URL(value) : animehayUrl(value);
  return `${url.pathname}${url.search}`;
}

const animehayChineseCategorySlugs = new Set([
  "cn-animation",
  "tien-hiep",
  "kiem-hiep",
  "vo-hiep",
  "huyen-ao",
  "di-gioi",
  "xuyen-khong",
  "trung-sinh",
  "cna-ngon-tinh",
  "cna-hai-huoc",
]);

const animehayChineseTitleSlugs = new Set([
  "tien-nghich",
  "muc-than-ky",
  "vo-than-chua-te",
  "dau-pha-thuong-khung",
  "the-gioi-hoan-my",
  "thon-phe-tinh-khong",
  "than-an-vuong-toa",
  "kiem-lai",
  "kiem-lai-2",
  "gia-thien",
  "pham-nhan-tu-tien",
  "dai-chua-te",
  "nghich-thien-chi-ton",
  "dai-luc-linh-vo",
  "tien-vo-de-ton",
  "doc-bo-tieu-dao",
  "linh-kiem-ton",
  "bach-luyen-thanh-than",
]);

function isAnimehayChineseAnimationSlug(slug = "") {
  const normalized = slug.toLowerCase();
  return (
    animehayChineseTitleSlugs.has(normalized) ||
    Array.from(animehayChineseTitleSlugs).some((blocked) => normalized === blocked || normalized.startsWith(`${blocked}-`))
  );
}

function hasAnimehayChineseCategory(categories: Array<{ slug?: string; name?: string }>) {
  return categories.some((category) => {
    const normalizedSlug = String(category.slug || "").replace(/^animehay-\d+-/i, "").toLowerCase();
    const normalizedName = decodeHtml(stripHtml(category.name || "")).toLowerCase();
    return animehayChineseCategorySlugs.has(normalizedSlug) || normalizedName.includes("cn animation") || normalizedName.includes("cna");
  });
}

function encodeAnimehayEpisodeId(watchPath: string) {
  return Buffer.from(JSON.stringify({ source: "animehay", watchPath }), "utf8").toString("base64url");
}

function decodeAnimehayEpisodeId(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<{ source: string; watchPath: string }>;
    if (parsed.source !== "animehay" || !parsed.watchPath || !/^\/xem-phim\/[a-z0-9-]+\.html$/i.test(parsed.watchPath)) return null;
    return parsed.watchPath;
  } catch {
    return null;
  }
}

function parseAnimehayPagination(html: string, currentPage: number, itemCount: number) {
  const pages = Array.from(html.matchAll(/tat-ca-(\d+)\.html/gi))
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const totalPages = Math.max(currentPage, ...pages, 1);

  return {
    totalItems: totalPages * itemCount,
    totalItemsPerPage: itemCount,
    currentPage,
    totalPages,
  };
}

function normalizeAnimehayCard(block: string) {
  const detailHref = block.match(/href=["']([^"']*\/thong-tin-phim\/([a-z0-9-]+)-(\d+)\.html)["'][^>]*class=["'][^"']*\bmc__link\b/i);
  if (!detailHref) return null;

  const href = animehayAbsoluteUrl(detailHref[1]);
  const rawSlug = detailHref[2];
  const movieId = detailHref[3];
  if (isAnimehayChineseAnimationSlug(rawSlug)) return null;
  const title =
    block.match(/title=["']([^"']+)["']/i)?.[1] ||
    block.match(/<div\b[^>]*class=["'][^"']*\bmc__name\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
    "";
  const image = block.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || "";
  const episode = block.match(/<a\b[^>]*class=["'][^"']*\bmc__ep-badge\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] || "";
  if (!title || !rawSlug || !movieId) return null;

  return {
    _id: `animehay-${movieId}`,
    name: decodeHtml(stripHtml(title)),
    origin_name: "",
    slug: animehayInternalSlug(rawSlug, movieId),
    poster_url: animehayAbsoluteUrl(image),
    thumb_url: animehayAbsoluteUrl(image),
    year: undefined,
    quality: "HD",
    episode_current: decodeHtml(stripHtml(episode)),
    content: "",
    type: "series",
    status: "ongoing",
    time: "",
    lang: "Vietsub",
    category: [{ _id: 1, name: "Anime", slug: animehayCategorySlug("anime", 1) }],
    country: [{ _id: 2, name: "Nhật Bản", slug: "nhat-ban" }],
    source: "animehay",
    source_url: href,
  };
}

function parseAnimehayMovies(html: string, limit = 24) {
  const found = new Map<string, ReturnType<typeof normalizeAnimehayCard>>();
  const cardRegex = /<a\b[^>]*href=["'][^"']*\/thong-tin-phim\/[a-z0-9-]+-\d+\.html["'][^>]*class=["'][^"']*\bmc__link\b[\s\S]*?(?=<a\b[^>]*href=["'][^"']*\/thong-tin-phim\/[a-z0-9-]+-\d+\.html|<ul\b[^>]*class=["'][^"']*pagination|<\/body>)/gi;

  for (const match of html.matchAll(cardRegex)) {
    const movie = normalizeAnimehayCard(match[0]);
    if (movie?.slug && !found.has(movie.slug)) {
      found.set(movie.slug, movie);
      if (found.size >= limit) break;
    }
  }

  return Array.from(found.values()).filter(Boolean);
}

function animehayListResponse(items: ReturnType<typeof parseAnimehayMovies>, html: string, page: number) {
  return {
    status: true,
    source: "ANIMEHAY",
    items,
    pagination: parseAnimehayPagination(html, page, items.length),
  };
}

function parseAnimehayCategories(html: string) {
  const found = new Map<string, { _id: number; name: string; slug: string; source: string }>();
  const tabStart = html.indexOf('id="tab-cate"');
  const tabSource = tabStart >= 0 ? html.slice(tabStart, html.indexOf('id="tab-years"', tabStart) > tabStart ? html.indexOf('id="tab-years"', tabStart) : undefined) : html;
  const regex = /<a\b[^>]*href=["']\/the-loai\/([a-z0-9-]+)-(\d+)\.html["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of tabSource.matchAll(regex)) {
    const rawSlug = match[1];
    const id = Number(match[2]);
    const name = decodeHtml(stripHtml(match[3]));
    if (!rawSlug || !Number.isFinite(id) || !name) continue;
    if (animehayChineseCategorySlugs.has(rawSlug.toLowerCase())) continue;
    found.set(String(id), { _id: id, name, slug: animehayCategorySlug(rawSlug, id), source: "animehay" });
  }

  return Array.from(found.values());
}

function parseAnimehayEpisodes(html: string) {
  const found = new Map<string, { _id: string; name: string; slug: string; link_embed: string; link_m3u8: string; open_external: boolean }>();
  const regex = /<a\b[^>]*href=["']([^"']*\/xem-phim\/([a-z0-9-]+)-tap-([a-z0-9-.]+)-(\d+)\.html)["'][^>]*class=["'][^"']*\baim-ep-btn\b[^"']*["'][^>]*title=["']([^"']*)["'][^>]*>/gi;

  for (const match of html.matchAll(regex)) {
    const watchPath = animehayWatchPathFromUrl(match[1]);
    const episodeNo = decodeHtml(stripHtml(match[3] || match[5] || ""));
    const episodeId = match[4];
    const encodedId = encodeAnimehayEpisodeId(watchPath);
    if (!episodeId || found.has(episodeId)) continue;
    found.set(episodeId, {
      _id: encodedId,
      name: episodeNo ? `Tập ${episodeNo}` : decodeHtml(stripHtml(match[5] || "Tập phim")),
      slug: `tap-${episodeNo || episodeId}`.replace(/[^a-z0-9-.]+/gi, "-").toLowerCase(),
      link_embed: `/api/animehay/player/${encodedId}`,
      link_m3u8: animehayHlsUrl(encodedId),
      open_external: false,
    });
  }

  return Array.from(found.values());
}

function normalizeAnimehayDetail(html: string, rawSlug: string, movieId: string) {
  const title = html.match(/<h1\b[^>]*class=["'][^"']*\baim-hero__title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "";
  const originTitle = html.match(/<div\b[^>]*class=["'][^"']*\baim-hero__alt-name\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  const poster =
    html.match(/<img\b[^>]*id=["']aim-poster-img["'][^>]*src=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    "";
  const description =
    html.match(/<div\b[^>]*id=["']aim-desc-content["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
    html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    "";
  const year = Number(html.match(/<span\b[^>]*class=["'][^"']*\baim-meta-item\b[^"']*["'][^>]*>[\s\S]*?(\d{4})[\s\S]*?<\/span>/i)?.[1]);
  const episodeTotal = stripHtml(html.match(/<span\b[^>]*class=["'][^"']*\baim-meta-item\b[^"']*["'][^>]*>[\s\S]*?(\d+)\s*Tập[\s\S]*?<\/span>/i)?.[1] || "");
  const categories = Array.from(html.matchAll(/<a\b[^>]*href=["']\/the-loai\/([a-z0-9-]+)-(\d+)\.html["'][^>]*class=["'][^"']*\baim-cate-chip\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)).map((match) => ({
    _id: Number(match[2]),
    name: decodeHtml(stripHtml(match[3])),
    slug: animehayCategorySlug(match[1], match[2]),
  }));
  if (isAnimehayChineseAnimationSlug(rawSlug) || hasAnimehayChineseCategory(categories)) return null;
  const score = html.match(/aim-meta-score[\s\S]*?([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  const voteCount = html.match(/\((\d+)\s*đánh/i)?.[1];
  const episodes = parseAnimehayEpisodes(html);

  return {
    _id: `animehay-${movieId}`,
    name: decodeHtml(stripHtml(title)) || rawSlug,
    origin_name: decodeHtml(stripHtml(originTitle)),
    slug: animehayInternalSlug(rawSlug, movieId),
    poster_url: animehayAbsoluteUrl(poster),
    thumb_url: animehayAbsoluteUrl(poster),
    year: Number.isFinite(year) ? year : undefined,
    quality: "HD",
    episode_current: episodes[0]?.name || "",
    episode_total: episodeTotal,
    content: decodeHtml(stripHtml(description)),
    type: "series",
    status: /Hoàn thành/i.test(html) ? "completed" : "ongoing",
    time: "",
    lang: "Vietsub",
    category: categories,
    country: [{ _id: 2, name: "Nhật Bản", slug: "nhat-ban" }],
    tmdb: {
      vote_average: score,
      vote_count: voteCount,
    },
    source: "animehay",
    source_url: String(animehayUrl(`/thong-tin-phim/${rawSlug}-${movieId}.html`)),
  };
}

function parseAnimehayPlayerUrl(html: string) {
  const match = html.match(/var\s+\$wp_servers\s*=\s*\{([\s\S]*?)\};/i);
  if (!match) return "";
  return match[1].match(/["']?[A-Za-z0-9_-]+["']?\s*:\s*["']([^"']+)["']/)?.[1] || "";
}

function parseAnimehayM3u8Url(html: string) {
  return html.match(/var\s+M3U8_URL\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i)?.[1] || "";
}

function animehayHlsUrl(episodeId: string) {
  return `/api/animehay/hls/${episodeId}`;
}

function animehayHlsProxyUrl(url: string) {
  return `/api/animehay/hls-proxy?url=${encodeURIComponent(url)}`;
}

function assertAllowedAnimehayMediaUrl(value: string) {
  const url = new URL(value);
  const allowedHosts = ["ahay.stream", "www.ahay.stream"];
  if (!allowedHosts.includes(url.hostname) && !/\.vipah\d*\.xyz$/i.test(url.hostname) && !/^sv\d+\.vipah\d*\.xyz$/i.test(url.hostname)) {
    throw new Error("Blocked AnimeHay media host");
  }
  return url;
}

function rewriteM3u8Playlist(playlist: string, baseUrl: URL) {
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      return animehayHlsProxyUrl(String(new URL(trimmed, baseUrl)));
    })
    .join("\n");
}

async function fetchAnimehayM3u8FromWatchPath(watchPath: string) {
  const watchHtml = await fetchAnimehayText(watchPath);
  const playerUrl = parseAnimehayPlayerUrl(watchHtml);
  if (!playerUrl) return "";
  const playerHtml = await fetchAnimehayText(playerUrl);
  return parseAnimehayM3u8Url(playerHtml);
}

function animehayScheduleResponse(html: string) {
  const items: Array<{ _id: string; name: string; slug: string; time: string; days: string[]; showtime: string; poster_url?: string; source: string }> = [];
  const byDay: Record<string, typeof items> = {};
  const tokenRegex =
    /<div\b[^>]*class=["'][^"']*\bschedule-col-header\b[^"']*["'][^>]*>([\s\S]*?)<\/div>|<a\b[^>]*href=["']([^"']*\/thong-tin-phim\/([a-z0-9-]+)-(\d+)\.html)["'][^>]*class=["'][^"']*\bschedule-item\b[^"']*["'][^>]*title=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let currentDay = "Lịch phát sóng";

  for (const match of html.matchAll(tokenRegex)) {
    if (match[1]) {
      currentDay = decodeHtml(stripHtml(match[1])) || currentDay;
      continue;
    }

    const rawSlug = match[3];
    const movieId = match[4];
    const name = decodeHtml(stripHtml(match[5]));
    const body = match[6] || "";
    const poster = body.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || "";
    const time = decodeHtml(stripHtml(body.match(/<div\b[^>]*class=["'][^"']*\bschedule-item-meta\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || ""));
    const item = {
      _id: `animehay-${movieId}`,
      name,
      slug: animehayInternalSlug(rawSlug, movieId),
      time,
      days: [currentDay],
      showtime: [currentDay, time].filter(Boolean).join(" - "),
      poster_url: animehayAbsoluteUrl(poster),
      source: "animehay",
    };
    items.push(item);
    byDay[currentDay] = [...(byDay[currentDay] || []), item];
  }

  return {
    status: true,
    source: "ANIMEHAY",
    items,
    byDay,
    pagination: {
      totalItems: items.length,
      totalItemsPerPage: items.length,
      currentPage: 1,
      totalPages: 1,
    },
  };
}

function hhkungfuScheduleResponse(posts: HhpandaPost[], page: number, total: number, totalPages: number) {
  const items = posts
    .map((post) => {
      const showtimes = termsFromPost(post, "showtimes");

      return {
        _id: post.id,
        name: decodeHtml(stripHtml(post.title?.rendered || "")),
        slug: post.slug,
        time: "",
        days: showtimes.map((item) => item.name),
        showtime: showtimes.map((item) => item.name).join(", "),
      };
    })
    .filter((item) => item.showtime);
  const byDay = items.reduce<Record<string, typeof items>>((result, item) => {
    for (const day of item.days.length ? item.days : ["Chưa rõ"]) {
      result[day] = [...(result[day] || []), item];
    }
    return result;
  }, {});

  return {
    status: true,
    source: "HHKUNGFU",
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
    xFrameOptions: false,
  }),
);
app.use(
  cors({
    origin: corsOrigins,
  }),
);
app.use("/api", apiLimiter);
app.use("/api/streamfree", express.raw({ type: "*/*", limit: "2mb" }));
app.use("/embed", express.raw({ type: "*/*", limit: "2mb" }));
app.use("/public", express.raw({ type: "*/*", limit: "2mb" }));
app.use("/cdn-cgi", express.raw({ type: "*/*", limit: "2mb" }));
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
    hhkungfu: hhkungfuBaseUrl,
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

app.get("/api/movies/latest", async (request, response) => {
  const page = Number(request.query.page || 1);
  const limit = Number(request.query.limit || 24);

  try {
    if (requestWantsAnimehay(request)) {
      const html = await fetchAnimehayText(animehayLatestPagePath(page));
      response.json(animehayListResponse(parseAnimehayMovies(html, limit), html, page));
      return;
    }

    let html = await fetchHhkungfuText(hhkungfuLatestPagePath(page));
    const itemsBySlug = new Map<string, ReturnType<typeof parseHhkungfuLatestMovies>[number]>();

    for (const item of parseHhkungfuLatestMovies(html, limit)) {
      if (!item) continue;
      itemsBySlug.set(item.slug, item);
    }

    let nextPage = page + 1;
    while (itemsBySlug.size < limit && nextPage <= page + 3) {
      const nextHtml = await fetchHhkungfuText(hhkungfuLatestPagePath(nextPage));
      for (const item of parseHhkungfuLatestMovies(nextHtml, limit)) {
        if (!item) continue;
        if (!itemsBySlug.has(item.slug)) itemsBySlug.set(item.slug, item);
        if (itemsBySlug.size >= limit) break;
      }
      html = `${html}${nextHtml}`;
      nextPage += 1;
    }

    response.json(hhkungfuLatestResponse(Array.from(itemsBySlug.values()).slice(0, limit), html, page));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load latest movies",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/movies/popular", async (request, response) => {
  const page = Number(request.query.page || 1);
  const limit = Number(request.query.limit || 24);

  try {
    if (requestWantsAnimehay(request)) {
      const html = await fetchAnimehayText(animehayLatestPagePath(page));
      response.json(animehayListResponse(parseAnimehayMovies(html, limit), html, page));
      return;
    }

    const html = await fetchHhkungfuText(hhkungfuPopularPagePath(page));
    const items = parseHhkungfuLatestMovies(html, limit).slice(0, limit);

    response.json(hhkungfuLatestResponse(items, html, page));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load popular movies",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/movies/completed", async (request, response) => {
  const page = Number(request.query.page || 1);

  try {
    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 100),
      _embed: 1,
    });
    const completed = result.data.filter((post) => {
      const status = termsFromPost(post, "status");
      return status.some((item) => /complete|completed|hoan-thanh|full/i.test(`${item.slug} ${item.name}`));
    });

    response.json({
      ...hhkungfuListResponse("hh3d", completed, page, completed.length, 1),
      source: "HHKUNGFU",
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load completed movies",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/movies/schedule", async (request, response) => {
  const page = Number(request.query.page || 1);

  try {
    if (requestWantsAnimehay(request)) {
      const html = await fetchAnimehayText("/lich-phat-song");
      response.json(animehayScheduleResponse(html));
      return;
    }

    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 100),
      _embed: 1,
    });

    response.json(hhkungfuScheduleResponse(result.data, page, result.total, result.totalPages));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load movie schedule",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/movies/categories", async (request, response) => {
  try {
    if (requestWantsAnimehay(request)) {
      const html = await fetchAnimehayText("/");
      response.json(parseAnimehayCategories(html));
      return;
    }

    const result = await fetchHhkungfuJson<HhpandaTerm[]>("/wp-json/wp/v2/categories", {
      per_page: 100,
    });

    response.json(result.data.map((item) => ({ _id: item.id, name: item.name, slug: item.slug })));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load movie categories",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/movies/category/:slug", async (request, response) => {
  const page = Number(request.query.page || 1);

  try {
    const animehayCategory = parseAnimehayCategorySlug(String(request.params.slug));
    if (requestWantsAnimehay(request) || animehayCategory) {
      if (!animehayCategory) {
        response.status(404).json({ status: false, message: "Khong tim thay the loai AnimeHay" });
        return;
      }
      const html = await fetchAnimehayText(`/the-loai/${animehayCategory.rawSlug}-${animehayCategory.categoryId}.html`);
      response.json(animehayListResponse(parseAnimehayMovies(html, Number(request.query.limit || 24)), html, page));
      return;
    }

    const categoryResult = await fetchHhkungfuJson<HhpandaTerm[]>("/wp-json/wp/v2/categories", {
      slug: String(request.params.slug),
      per_page: 1,
    });
    const category = categoryResult.data[0];

    if (!category) {
      response.status(404).json({ status: false, message: "Không tìm thấy thể loại" });
      return;
    }

    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 24),
      categories: category.id,
      _embed: 1,
    });

    response.json({
      ...hhkungfuListResponse("hh3d", result.data, page, result.total, result.totalPages),
      source: "HHKUNGFU",
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load movie category",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/movies/:slug/episodes", async (request, response) => {
  try {
    const animehayMovie = parseAnimehayInternalSlug(String(request.params.slug));
    if (animehayMovie) {
      const html = await fetchAnimehayText(`/thong-tin-phim/${animehayMovie.rawSlug}-${animehayMovie.movieId}.html`);
      response.json({
        status: true,
        source: "ANIMEHAY",
        episodes: [{ server_name: "AnimeHay", server_data: parseAnimehayEpisodes(html) }],
      });
      return;
    }

    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      slug: String(request.params.slug),
      _embed: 1,
    });
    const post = result.data[0];

    if (!post) {
      response.status(404).json({ status: false, message: "Không tìm thấy phim" });
      return;
    }

    const detailHtml = await fetchHhkungfuText(post.link);
    response.json({
      status: true,
      source: "HHKUNGFU",
      episodes: hhkungfuEpisodeServers(detailHtml),
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load movie episodes",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/movies/:slug", async (request, response) => {
  try {
    const animehayMovie = parseAnimehayInternalSlug(String(request.params.slug));
    if (animehayMovie) {
      const html = await fetchAnimehayText(`/thong-tin-phim/${animehayMovie.rawSlug}-${animehayMovie.movieId}.html`);
      const movie = normalizeAnimehayDetail(html, animehayMovie.rawSlug, animehayMovie.movieId);
      if (!movie) {
        response.status(404).json({ status: false, message: "Anime nay da duoc an khoi nguon AnimeHay" });
        return;
      }
      response.json({
        status: true,
        source: "ANIMEHAY",
        movie,
      });
      return;
    }

    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      slug: String(request.params.slug),
      _embed: 1,
    });
    const post = result.data[0];

    if (!post) {
      response.status(404).json({ status: false, message: "Không tìm thấy phim" });
      return;
    }

    response.json({
      status: true,
      source: "HHKUNGFU",
      movie: normalizeHhkungfuPost(post),
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load movie detail",
      detail: errorDetail(error),
    });
  }
});

app.get("/api/episodes/:episodeId", async (request, response) => {
  const animehayWatchPath = decodeAnimehayEpisodeId(String(request.params.episodeId));
  if (animehayWatchPath) {
    response.json({
      status: true,
      source: "ANIMEHAY",
      episode: {
        _id: request.params.episodeId,
        playerType: "iframe",
        link_embed: `/api/animehay/player/${request.params.episodeId}`,
        open_external: false,
      },
    });
    return;
  }

  const episode = decodeEpisodeId(String(request.params.episodeId));

  if (!episode) {
    response.status(400).json({ status: false, message: "Invalid episode id" });
    return;
  }

  const fallbackEmbed = hhkungfuProxyPlayerUrl(String(episode.postId), String(episode.chapter), String(episode.type), String(episode.sv));

  try {
    const playerHtml = await fetchHhkungfuPlayerHtml({
      postId: String(episode.postId),
      chapter: String(episode.chapter),
      type: String(episode.type),
      sv: String(episode.sv),
    });
    const directEmbed = parseIframeSrc(playerHtml);
    const proxiedEmbed = directEmbed ? streamfreeProxyUrl(directEmbed) : "";

    response.json({
      status: true,
      source: "HHKUNGFU",
      episode: {
        _id: request.params.episodeId,
        playerType: "iframe",
        link_embed: proxiedEmbed || fallbackEmbed,
        fallback_embed: directEmbed || fallbackEmbed,
        open_external: Boolean(directEmbed),
      },
    });
  } catch (error) {
    response.json({
      status: true,
      source: "HHKUNGFU",
      episode: {
        _id: request.params.episodeId,
        playerType: "iframe",
        link_embed: fallbackEmbed,
        open_external: false,
      },
      detail: errorDetail(error),
    });
  }
});

app.get("/api/animehay/player/:episodeId", async (request, response) => {
  const watchPath = decodeAnimehayEpisodeId(String(request.params.episodeId));

  if (!watchPath) {
    response.status(400).type("text/html").send("Invalid AnimeHay player request");
    return;
  }

  try {
    const html = await fetchAnimehayText(watchPath);
    const iframeUrl = parseAnimehayPlayerUrl(html);
    if (!iframeUrl) {
      response.status(404).type("text/html").send("Cannot find AnimeHay player");
      return;
    }

    response
      .type("text/html")
      .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}iframe{position:fixed;inset:0;display:block;width:100%!important;height:100%!important;border:0}</style></head><body><iframe src="${iframeUrl}" allowfullscreen allow="autoplay;encrypted-media;fullscreen" loading="lazy"></iframe></body></html>`);
  } catch (error) {
    response.status(502).type("text/html").send(errorDetail(error) || "Cannot load AnimeHay player");
  }
});

app.get("/api/animehay/hls/:episodeId", async (request, response) => {
  const watchPath = decodeAnimehayEpisodeId(String(request.params.episodeId));

  if (!watchPath) {
    response.status(400).type("text/plain").send("Invalid AnimeHay HLS request");
    return;
  }

  try {
    const m3u8Url = await fetchAnimehayM3u8FromWatchPath(watchPath);
    if (!m3u8Url) {
      response.status(404).type("text/plain").send("Cannot find AnimeHay HLS");
      return;
    }

    const url = assertAllowedAnimehayMediaUrl(m3u8Url);
    const result = await fetch(url, {
      headers: {
        accept: "application/vnd.apple.mpegurl,*/*",
        referer: animehayBaseUrl,
        "user-agent": "Mozilla/5.0 (compatible; TSVERSE/0.1)",
      },
    });

    if (!result.ok) throw new Error(`AnimeHay HLS returned ${result.status}`);
    const playlist = await result.text();
    response.setHeader("cache-control", "no-store");
    response.type("application/vnd.apple.mpegurl").send(rewriteM3u8Playlist(playlist, url));
  } catch (error) {
    response.status(502).type("text/plain").send(errorDetail(error) || "Cannot load AnimeHay HLS");
  }
});

app.get("/api/animehay/hls-proxy", async (request, response) => {
  const rawUrl = String(request.query.url || "");

  if (!rawUrl) {
    response.status(400).type("text/plain").send("Missing media url");
    return;
  }

  try {
    const url = assertAllowedAnimehayMediaUrl(rawUrl);
    const result = await fetch(url, {
      headers: {
        accept: "*/*",
        referer: animehayBaseUrl,
        "user-agent": "Mozilla/5.0 (compatible; TSVERSE/0.1)",
      },
    });

    if (!result.ok) throw new Error(`AnimeHay media returned ${result.status}`);

    const contentType = result.headers.get("content-type") || "";
    response.setHeader("cache-control", "public, max-age=300");

    if (contentType.includes("mpegurl") || url.pathname.endsWith(".m3u8")) {
      const playlist = await result.text();
      response.type("application/vnd.apple.mpegurl").send(rewriteM3u8Playlist(playlist, url));
      return;
    }

    const bytes = Buffer.from(await result.arrayBuffer());
    response.type(contentType || "application/octet-stream").send(bytes);
  } catch (error) {
    response.status(502).type("text/plain").send(errorDetail(error) || "Cannot proxy AnimeHay media");
  }
});

async function proxyStreamfreeRequest(request: express.Request, response: express.Response, rawPath: string) {
  if (!rawPath || rawPath.includes("..")) {
    response.status(400).type("text/plain").send("Invalid streamfree path");
    return;
  }

  try {
    const url = new URL(`/${rawPath}`, "https://streamfree.vip");
    for (const [key, value] of Object.entries(request.query)) {
      if (key === "url") continue;
      if (Array.isArray(value)) {
        value.forEach((item) => url.searchParams.append(key, String(item)));
      } else if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      accept: String(request.headers.accept || "*/*"),
      referer: hhkungfuBaseUrl,
      origin: "https://streamfree.vip",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    };
    const contentTypeHeader = request.headers["content-type"];
    if (contentTypeHeader) headers["content-type"] = String(contentTypeHeader);
    if (request.headers.cookie) headers.cookie = String(request.headers.cookie);

    const init: RequestInit = {
      method: request.method,
      headers: {
        ...headers,
      },
    };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined) {
      init.body = typeof request.body === "string" || Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body);
    }

    const result = await fetch(url, init);

    if (!result.ok) throw new Error(`Streamfree returned ${result.status}`);

    const contentType = result.headers.get("content-type") || "application/octet-stream";
    const setCookie = result.headers.get("set-cookie");
    if (setCookie) response.setHeader("set-cookie", setCookie.replace(/Domain=streamfree\.vip;?\s*/gi, ""));
    response.setHeader("cache-control", contentType.includes("text/html") ? "no-store" : "public, max-age=300");

    if (contentType.includes("text/html")) {
      let html = await result.text();
      html = html
        .replace(/<head>/i, `<head><base href="/api/streamfree/">${streamfreeDetectorGuard}`)
        .replace(/(src|href)=["'](?:https?:)?\/\/streamfree\.vip\/([^"']+)["']/gi, '$1="/api/streamfree/$2"');
      html = rewriteStreamfreeUrls(html);
      html = neutralizeDebuggerScript(html);
      response.setHeader(
        "content-security-policy",
        `default-src 'self' data: blob: https: http:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; connect-src 'self' https: http:; worker-src 'self' blob:; frame-ancestors 'self' ${clientUrl}`,
      );
      response.type("text/html").send(html);
      return;
    }

    if (contentType.includes("javascript") || url.pathname.endsWith(".js")) {
      let script = await result.text();
      script = rewriteStreamfreeUrls(script);
      script = neutralizeDebuggerScript(script);
      response.type(contentType).send(`${streamfreeDetectorGuardJs}\n${script}`);
      return;
    }

    const bytes = Buffer.from(await result.arrayBuffer());
    response.type(contentType).send(bytes);
  } catch (error) {
    response.status(502).type("text/plain").send(errorDetail(error) || "Cannot proxy Streamfree");
  }
}

app.all("/api/streamfree/*", async (request, response) => {
  const rawPath = ((request.params as unknown as Record<string, string>)[0] || "");
  await proxyStreamfreeRequest(request, response, rawPath);
});

app.all("/embed/*", async (request, response) => {
  const rawPath = `embed/${(request.params as unknown as Record<string, string>)[0] || ""}`;
  await proxyStreamfreeRequest(request, response, rawPath);
});

app.all("/public/*", async (request, response) => {
  const rawPath = `public/${(request.params as unknown as Record<string, string>)[0] || ""}`;
  await proxyStreamfreeRequest(request, response, rawPath);
});

app.get("/streamfree-guard.js", (_request, response) => {
  response.setHeader("cache-control", "public, max-age=3600");
  response.type("text/javascript").send(streamfreeDetectorGuardJs);
});

app.all(["/cdn-cgi/rum", "/api/streamfree/cdn-cgi/rum"], (_request, response) => {
  response.status(204).end();
});

app.all("/cdn-cgi/*", async (request, response) => {
  const rawPath = `cdn-cgi/${(request.params as unknown as Record<string, string>)[0] || ""}`;
  await proxyStreamfreeRequest(request, response, rawPath);
});

app.get("/api/hhkungfu/player", async (request, response) => {
  const postId = String(request.query.post_id || "").trim();
  const chapter = String(request.query.chapter_st || "").trim();
  const type = String(request.query.type || "pro").trim();
  const sv = String(request.query.sv || "1").trim();

  if (!/^\d+$/.test(postId) || !/^[a-z0-9-]+$/i.test(chapter) || !/^[a-z0-9-]+$/i.test(type) || !/^\d+$/.test(sv)) {
    response.status(400).type("text/html").send("Invalid player request");
    return;
  }

  try {
    const playerHtml = rewriteStreamfreeUrls(await fetchHhkungfuPlayerHtml({ postId, chapter, type, sv }));
    response
      .type("text/html")
      .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}iframe{position:fixed;inset:0;display:block;width:100%!important;height:100%!important;border:0}.player-label-mask{position:fixed;top:0;left:0;z-index:2147483647;width:min(340px,55vw);height:64px;pointer-events:none;background:linear-gradient(90deg,#000 0%,#000 70%,rgba(0,0,0,0) 100%)}</style></head><body>${playerHtml}<div class="player-label-mask" aria-hidden="true"></div></body></html>`);
  } catch (error) {
    response.status(502).type("text/html").send(errorDetail(error) || "Cannot load HHKUNGFU player");
  }
});

app.get(["/api/hh3d/phim-moi-cap-nhat", "/api/hhpanda/phim-moi-cap-nhat"], async (request, response) => {
  const source = hhkungfuSourceFromRequest(request);
  const page = Number(request.query.page || 1);

  try {
    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 24),
      _embed: 1,
    });

    response.json(hhkungfuListResponse(source, result.data, page, result.total, result.totalPages));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHKUNGFU latest movies",
      detail: errorDetail(error),
    });
  }
});

app.get(["/api/hh3d/tim-kiem", "/api/hhpanda/tim-kiem"], async (request, response) => {
  const source = hhkungfuSourceFromRequest(request);
  const page = Number(request.query.page || 1);
  const keyword = String(request.query.keyword || "").trim();

  if (!keyword) {
    response.json(hhkungfuListResponse(source, [], page, 0, 0));
    return;
  }

  try {
    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 24),
      search: keyword,
      _embed: 1,
    });

    response.json(hhkungfuListResponse(source, result.data, page, result.total, result.totalPages));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot search HHKUNGFU",
      detail: errorDetail(error),
    });
  }
});

app.get(["/api/hh3d/the-loai", "/api/hhpanda/the-loai"], async (_request, response) => {
  try {
    const result = await fetchHhkungfuJson<HhpandaTerm[]>("/wp-json/wp/v2/categories", {
      per_page: 100,
    });

    response.json(result.data.map((item) => ({ _id: item.id, name: item.name, slug: item.slug })));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHKUNGFU categories",
      detail: errorDetail(error),
    });
  }
});

app.get(["/api/hh3d/the-loai/:slug", "/api/hhpanda/the-loai/:slug"], async (request, response) => {
  const source = hhkungfuSourceFromRequest(request);
  const page = Number(request.query.page || 1);

  try {
    const categoryResult = await fetchHhkungfuJson<HhpandaTerm[]>("/wp-json/wp/v2/categories", {
      slug: String(request.params.slug),
      per_page: 1,
    });
    const category = categoryResult.data[0];

    if (!category) {
      response.status(404).json({ status: false, message: "Không tìm thấy thể loại trên HHKUNGFU" });
      return;
    }

    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 24),
      categories: category.id,
      _embed: 1,
    });

    response.json(hhkungfuListResponse(source, result.data, page, result.total, result.totalPages));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHKUNGFU category",
      detail: errorDetail(error),
    });
  }
});

app.get(["/api/hh3d/quoc-gia", "/api/hhpanda/quoc-gia"], async (_request, response) => {
  try {
    const result = await fetchHhkungfuJson<HhpandaTerm[]>("/wp-json/wp/v2/country", {
      per_page: 100,
    });

    response.json(result.data.map((item) => ({ _id: item.id, name: item.name, slug: item.slug })));
  } catch {
    response.json([{ _id: 1, name: "Trung Quốc", slug: "trung-quoc" }]);
  }
});

app.get(["/api/hh3d/lich-chieu", "/api/hhpanda/lich-chieu"], async (request, response) => {
  const page = Number(request.query.page || 1);

  try {
    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 100),
      _embed: 1,
    });

    response.json(hhkungfuScheduleResponse(result.data, page, result.total, result.totalPages));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHKUNGFU schedule",
      detail: errorDetail(error),
    });
  }
});

app.get(["/api/hh3d/phim/:slug", "/api/hhpanda/phim/:slug"], async (request, response) => {
  const source = hhkungfuSourceFromRequest(request);

  try {
    const result = await fetchHhkungfuJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      slug: String(request.params.slug),
      _embed: 1,
    });
    const post = result.data[0];

    if (!post) {
      response.status(404).json({ status: false, message: "Không tìm thấy phim trên HHKUNGFU" });
      return;
    }

    const detailHtml = await fetchHhkungfuText(post.link);

    response.json({
      status: true,
      source: hhkungfuSourceLabel(source),
      movie: normalizeHhkungfuPost(post),
      episodes: hhkungfuEpisodeServers(detailHtml),
    });
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHKUNGFU movie detail",
      detail: errorDetail(error),
    });
  }
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

app.get("/api/hhpanda/the-loai/:slug", async (request, response) => {
  const page = Number(request.query.page || 1);

  try {
    const categoryResult = await fetchHhpandaJson<HhpandaTerm[]>("/wp-json/wp/v2/categories", {
      slug: request.params.slug,
      per_page: 1,
    });
    const category = categoryResult.data[0];

    if (!category) {
      response.status(404).json({ status: false, message: "Không tìm thấy thể loại trên HHPANDA" });
      return;
    }

    const result = await fetchHhpandaJson<HhpandaPost[]>("/wp-json/wp/v2/posts", {
      page,
      per_page: Number(request.query.limit || 24),
      categories: category.id,
      _embed: 1,
    });

    response.json(hhpandaListResponse(result.data, page, result.total, result.totalPages));
  } catch (error) {
    response.status(502).json({
      status: false,
      message: "Cannot load HHPANDA category",
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
