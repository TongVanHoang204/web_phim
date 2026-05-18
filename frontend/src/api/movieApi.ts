import axios from "axios";
import type { EpisodeItem, EpisodeServer, Movie, MovieDetailResponse, MovieResponse, Taxonomy } from "../@types/movie";

export type WatchHistoryPayload = {
  name: string;
  origin_name?: string;
  slug: string;
  poster_url?: string;
  thumb_url?: string;
  episodeName?: string;
  watchedAt: number;
};

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

const localClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000,
});

const DEFAULT_IMAGE_CDN = import.meta.env.VITE_IMAGE_CDN_BASE_URL || "https://phimimg.com";
const BLOCKED_TAXONOMY_SLUGS = new Set(["phim-18", "phim-18+", "18", "18-plus", "mien-tay", "tre-em"]);
const BLOCKED_TAXONOMY_NAMES = ["18+", "Miền Tây", "Trẻ Em"];

function absoluteImageUrl(url?: string, cdn = DEFAULT_IMAGE_CDN) {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const cleanUrl = url.startsWith("/") ? url : `/${url}`;
  return `${cdn}${cleanUrl}`;
}

function backendUrl(url?: string) {
  if (!url || !API_BASE_URL || url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${API_BASE_URL}${url.startsWith("/") ? url : `/${url}`}`;
}

function normalizeEpisode(episode: EpisodeItem): EpisodeItem {
  return {
    ...episode,
    link_embed: backendUrl(episode.link_embed) || episode.link_embed,
    link_m3u8: backendUrl(episode.link_m3u8),
    fallback_embed: backendUrl(episode.fallback_embed) || episode.fallback_embed,
  };
}

function normalizeEpisodeServers(servers: EpisodeServer[]) {
  return servers.map((server) => ({
    ...server,
    server_data: server.server_data.map(normalizeEpisode),
  }));
}

function normalizeMovie(movie: Movie): Movie {
  return {
    ...movie,
    source: movie.source || "hhkungfu",
    poster_url: absoluteImageUrl(movie.poster_url),
    thumb_url: absoluteImageUrl(movie.thumb_url),
  };
}

function unwrapItems<T>(payload: MovieResponse | T[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (Array.isArray(payload.items)) return payload.items as T[];
  if (Array.isArray(payload.data?.items)) return payload.data.items as T[];
  return [];
}

function paginationFrom(data: MovieResponse) {
  return data.pagination || data.data?.params?.pagination || data.params?.pagination;
}

function isBlockedTaxonomy(item: Taxonomy) {
  const slug = item.slug.toLowerCase();
  const name = item.name.toLowerCase();
  return BLOCKED_TAXONOMY_SLUGS.has(slug) || BLOCKED_TAXONOMY_NAMES.some((keyword) => name.includes(keyword.toLowerCase()));
}

export async function getLatestMovies(page = 1, limit = 24) {
  return getMovies({ page, limit, source: "all" });
}

function apiSourceFromType(type?: string | number) {
  return type === "japan" ? "animehay" : undefined;
}

function apiSourceFromParams(params: Record<string, string | number | undefined>) {
  if (params.source) return params.source;
  return apiSourceFromType(params.type);
}

export async function getTopViewedMovies(limit = 9, type?: string) {
  const { data } = await localClient.get<MovieResponse>("/api/movies/popular", {
    params: { page: 1, limit, source: apiSourceFromType(type) },
  });
  return unwrapItems<Movie>(data).map(normalizeMovie);
}

export async function getMovies(params: Record<string, string | number | undefined>) {
  const { data } = await localClient.get<MovieResponse>("/api/movies/latest", {
    params: {
      page: params.page || 1,
      limit: params.limit || 24,
      source: apiSourceFromParams(params),
    },
  });

  return {
    items: unwrapItems<Movie>(data).map(normalizeMovie),
    pagination: paginationFrom(data),
  };
}

export async function getMoviesByCategory(slug: string, params: Record<string, string | number | undefined> = {}) {
  const { data } = await localClient.get<MovieResponse>(`/api/movies/category/${slug}`, {
    params: {
      page: params.page || 1,
      limit: params.limit || 24,
      source: apiSourceFromType(params.type),
    },
  });

  return {
    items: unwrapItems<Movie>(data).map(normalizeMovie),
    pagination: paginationFrom(data),
  };
}

function readableText(value?: string) {
  if (!value) return "";
  let text = value;

  if (/(Ãƒ|Ã„|Ã†|Ã¡Âº|Ã¡Â»)/.test(text)) {
    try {
      const bytes = Uint8Array.from(Array.from(text), (char) => char.charCodeAt(0) & 0xff);
      const decoded = new TextDecoder("utf-8").decode(bytes);
      if (!decoded.includes("�")) text = decoded;
    } catch {
      return text;
    }
  }

  return text;
}

function normalizeSeriesText(value?: string) {
  return readableText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLocaleLowerCase("vi-VN")
    .replace(/[^a-z0-9()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSeasonWords(value: string) {
  return value
    .replace(/\([^)]*(phan|season|ss|s\d+)[^)]*\)/gi, " ")
    .replace(/\b(phan|season|ss)\s*(\d+|mot|hai|ba|bon|tu|nam|sau|bay|tam|chin|muoi)\b/gi, " ")
    .replace(/\bpart\s*\d+\b/gi, " ")
    .replace(/\bs\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSeriesTitle(value?: string) {
  return stripSeasonWords(normalizeSeriesText(value));
  return readableText(value)
    .toLocaleLowerCase("vi-VN")
    .replace(/\([^)]*(phần|phan|season|ss|s\d+)[^)]*\)/gi, " ")
    .replace(/\b(phần|phan|season)\s*\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function relatedKeyword(movie: Movie) {
  return stripSeasonWords(normalizeSeriesText(movie.name || movie.origin_name || ""));
  return (movie.name || movie.origin_name || "")
    .replace(/\([^)]*(phần|phan|season|ss|s\d+)[^)]*\)/gi, " ")
    .replace(/\b(phần|phan|season)\s*\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRelatedKeyword(keyword: string) {
  return keyword
    .replace(/\([^)]*(phần|phan|season|ss|s\d+)[^)]*\)/gi, " ")
    .replace(/\b(phần|phan|season)\s*\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalSeriesKey(value?: string) {
  return stripSeasonWords(normalizeSeriesText(value))
    .replace(/\b(the\s+)?final\b.*$/gi, " ")
    .replace(/\b(last attack|live action|chronicle|lost girls|picture drama|kuinaki sentaku|guren no yumiya|ova|specials?)\b.*$/gi, " ")
    .replace(/\bmovie\s*\d*\b.*$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function seriesKeys(...values: Array<string | undefined>) {
  const keys = new Set<string>();

  for (const value of values) {
    const text = readableText(value || "");
    if (!text.trim()) continue;

    for (const part of text.split(/\s+(?:-|–|—)\s+|[:/|]/g)) {
      const key = canonicalSeriesKey(part);
      if (key.length >= 3) keys.add(key);
    }

    const fullKey = canonicalSeriesKey(text);
    if (fullKey.length >= 3) keys.add(fullKey);
  }

  const combined = Array.from(keys).join(" ");
  if (combined.includes("attack on titan") || combined.includes("shingeki no kyojin")) {
    keys.add("attack on titan");
    keys.add("shingeki no kyojin");
  }

  return Array.from(keys);
}

function isSameSeries(baseTitles: string[], item: Movie) {
  const itemTitles = seriesKeys(item.name, item.origin_name);
  return baseTitles.some((baseTitle) =>
    itemTitles.some((itemTitle) => itemTitle === baseTitle || itemTitle.startsWith(`${baseTitle} `) || baseTitle.startsWith(`${itemTitle} `)),
  );
}

function uniqueRelatedKeywords(movie: Movie) {
  const values = [movie.name, movie.origin_name, relatedKeyword(movie), cleanSeriesTitle(movie.name), cleanSeriesTitle(movie.origin_name), ...seriesKeys(movie.name, movie.origin_name)]
    .map((value) => readableText(value || "").trim())
    .filter((value) => value.length >= 3);
  return Array.from(new Set(values)).slice(0, 5);
}

export async function getRelatedMovies(movie: Movie, limit = 8) {
  const baseTitles = seriesKeys(movie.name, movie.origin_name);
  const seen = new Set([movie.slug]);
  const related: Movie[] = [];

  function append(items: Movie[], options: { requireSameSeries?: boolean } = {}) {
    for (const item of items) {
      if (seen.has(item.slug)) continue;
      if (options.requireSameSeries && !isSameSeries(baseTitles, item)) continue;
      seen.add(item.slug);
      related.push(item);
      if (related.length >= limit) break;
    }
  }

  for (const keyword of uniqueRelatedKeywords(movie)) {
    try {
      append(await searchMovies(keyword), { requireSameSeries: true });
    } catch {
      continue;
    }
    if (related.length >= limit) break;
  }

  return related.slice(0, limit);
}

export async function searchMovies(keyword: string) {
  const { data } = await localClient.get<MovieResponse>("/api/movies/search", {
    params: { keyword, page: 1, limit: 100, source: "all" },
  });
  const normalizedKeyword = normalizeSeriesText(keyword);
  const keywordTokens = normalizedKeyword.split(" ").filter((token) => token.length >= 2);

  function searchScore(movie: Movie) {
    const haystack = normalizeSeriesText(`${movie.name} ${movie.origin_name || ""} ${movie.slug}`);
    if (!haystack || !keywordTokens.length) return 0;
    if (haystack.includes(normalizedKeyword)) return 100 + normalizedKeyword.length;

    const matchedTokens = keywordTokens.filter((token) => haystack.includes(token)).length;
    if (!matchedTokens) return 0;
    return matchedTokens === keywordTokens.length ? 60 + matchedTokens : matchedTokens;
  }

  return unwrapItems<Movie>(data)
    .map(normalizeMovie)
    .map((movie) => ({ movie, score: searchScore(movie) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ movie }) => movie);
}

export async function getCategories(type: string = "all") {
  const { data } = await localClient.get<MovieResponse | Taxonomy[]>("/api/movies/categories", {
    params: { source: apiSourceFromType(type) },
  });
  return unwrapItems<Taxonomy>(data)
    .filter((item) => !isBlockedTaxonomy(item))
    .map((item) => ({ ...item, source: item.source || (type === "japan" ? "animehay" : "hhkungfu") }));
}

export async function getCountries(type: string = "all") {
  if (type === "japan") return [{ _id: 2, name: "Nhật Bản", slug: "nhat-ban", source: "animehay" as const }];
  return [{ _id: 1, name: "Trung Quốc", slug: "trung-quoc", source: "hhkungfu" as const }];
}

export async function getMovieDetail(slug: string) {
  const [{ data: detailData }, { data: episodeData }] = await Promise.all([
    localClient.get<MovieDetailResponse>(`/api/movies/${slug}`),
    localClient.get<MovieDetailResponse & { episodes?: EpisodeServer[] }>(`/api/movies/${slug}/episodes`),
  ]);
  const movie = detailData.movie || detailData.data?.movie;

  return {
    movie: movie ? normalizeMovie(movie) : undefined,
    episodes: normalizeEpisodeServers(episodeData.episodes || episodeData.data?.episodes || []),
  };
}

export async function getEpisodePlayer(episodeId: string) {
  const { data } = await localClient.get<{ episode?: EpisodeItem }>(`/api/episodes/${episodeId}`);
  return data.episode ? normalizeEpisode(data.episode) : data.episode;
}

export async function getWatchHistory() {
  try {
    return JSON.parse(localStorage.getItem("watchHistory") || "[]") as WatchHistoryPayload[];
  } catch {
    return [];
  }
}

export async function saveWatchHistoryEntry(item: WatchHistoryPayload) {
  try {
    return JSON.parse(localStorage.getItem("watchHistory") || "[]") as WatchHistoryPayload[];
  } catch {
    return [item];
  }
}
