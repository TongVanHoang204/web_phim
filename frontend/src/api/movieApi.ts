import axios from "axios";
import type { Movie, MovieDetailResponse, MovieResponse, Taxonomy } from "../@types/movie";

export type WatchHistoryPayload = {
  name: string;
  origin_name?: string;
  slug: string;
  poster_url?: string;
  thumb_url?: string;
  episodeName?: string;
  watchedAt: number;
};

const client = axios.create({
  baseURL: import.meta.env.VITE_PHIMAPI_BASE_URL || "https://phimapi.com",
  timeout: 60000,
});
const localClient = axios.create({
  baseURL: "",
  timeout: 60000,
});

const DEFAULT_IMAGE_CDN = import.meta.env.VITE_IMAGE_CDN_BASE_URL || "https://phimimg.com";
const ALLOWED_ANIMATION_COUNTRIES = new Set(["trung-quoc", "nhat-ban"]);
const BLOCKED_TAXONOMY_SLUGS = new Set(["phim-18", "phim-18+", "18", "18-plus", "mien-tay", "tre-em"]);
const BLOCKED_TAXONOMY_NAMES = ["18+", "Miền Tây", "Trẻ Em"];

type CategorySource = NonNullable<Taxonomy["source"]>;

function absoluteImageUrl(url?: string, cdn = DEFAULT_IMAGE_CDN) {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const cleanUrl = url.startsWith("/") ? url : `/${url}`;
  return `${cdn}${cleanUrl}`;
}

function normalizeMovie(movie: Movie, cdn = DEFAULT_IMAGE_CDN): Movie {
  return {
    ...movie,
    poster_url: absoluteImageUrl(movie.poster_url, cdn),
    thumb_url: absoluteImageUrl(movie.thumb_url, cdn),
  };
}

function unwrapItems<T>(payload: MovieResponse | T[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (Array.isArray(payload.items)) return payload.items as T[];
  if (Array.isArray(payload.data?.items)) return payload.data.items as T[];
  return [];
}

function categorySlug(source: CategorySource, slug: string) {
  return source === "phimapi" ? slug : `${source}:${slug}`;
}

function categoryFromSource(item: Taxonomy, source: CategorySource): Taxonomy {
  return {
    ...item,
    source,
    slug: categorySlug(source, item.slug),
  };
}

function parseCategorySlug(slug: string): { source: CategorySource; slug: string } {
  const [source, ...rest] = slug.split(":");
  if ((source === "hh3d" || source === "hhpanda") && rest.length) {
    return { source, slug: rest.join(":") };
  }
  return { source: "phimapi", slug };
}

function movieFromSource(movie: Movie, source: CategorySource) {
  const normalized = normalizeMovie(movie);
  return {
    ...normalized,
    source,
    slug: source === "phimapi" ? normalized.slug : `${source}:${normalized.slug}`,
  };
}

function isAnimeOrDonghua(movie: Movie) {
  const hasAnimationType = movie.type === "hoathinh";
  const hasAnimationCategory = movie.category?.some((item) => item.slug === "hoat-hinh");
  const hasAllowedCountry = movie.country?.some((item) => ALLOWED_ANIMATION_COUNTRIES.has(item.slug));
  const hasBlockedCategory = movie.category?.some(isBlockedTaxonomy);
  return Boolean((hasAnimationType || hasAnimationCategory) && !hasBlockedCategory && (!movie.country?.length || hasAllowedCountry));
}

function isBlockedTaxonomy(item: Taxonomy) {
  const slug = item.slug.toLowerCase();
  const name = item.name.toLowerCase();
  return BLOCKED_TAXONOMY_SLUGS.has(slug) || BLOCKED_TAXONOMY_NAMES.some((keyword) => name.includes(keyword.toLowerCase()));
}

export async function getLatestMovies(page = 1) {
  return getMovies({ type: "all", page, limit: 40 });
}

export async function getTopViewedMovies(limit = 9) {
  const { data } = await client.get<MovieResponse>("/v1/api/danh-sach/hoat-hinh", {
    params: {
      page: 1,
      limit,
      sort_field: "view",
      sort_type: "desc",
      sort_lang: "vietsub",
    },
  });
  const cdn = data.data?.APP_DOMAIN_CDN_IMAGE || DEFAULT_IMAGE_CDN;
  return unwrapItems<Movie>(data)
    .map((movie) => normalizeMovie(movie, cdn))
    .filter(isAnimeOrDonghua);
}

export async function getMovies(params: Record<string, string | number | undefined>) {
  const countryMap: Record<string, string | undefined> = {
    china: "trung-quoc",
    japan: "nhat-ban",
  };
  const country = typeof params.type === "string" ? countryMap[params.type] : undefined;
  const { data } = await client.get<MovieResponse>("/v1/api/danh-sach/hoat-hinh", {
    params: {
      page: params.page || 1,
      limit: params.limit || 24,
      country,
      sort_field: "modified.time",
      sort_type: "desc",
      sort_lang: "vietsub",
    },
  });
  const cdn = data.data?.APP_DOMAIN_CDN_IMAGE || DEFAULT_IMAGE_CDN;
  const items = unwrapItems<Movie>(data)
    .map((movie) => normalizeMovie(movie, cdn))
    .filter(isAnimeOrDonghua);

  return {
    items,
    pagination: data.pagination || data.data?.params?.pagination || data.params?.pagination,
  };
}

export async function getMoviesByCategory(slug: string, params: Record<string, string | number | undefined> = {}) {
  const category = parseCategorySlug(slug);

  if (category.source === "hh3d" || category.source === "hhpanda") {
    const { data } = await localClient.get<MovieResponse>(`/api/${category.source}/the-loai/${category.slug}`, {
      params: {
        page: params.page || 1,
        limit: params.limit || 24,
      },
    });

    return {
      items: unwrapItems<Movie>(data).map((movie) => movieFromSource(movie, category.source)),
      pagination: data.pagination || data.data?.params?.pagination || data.params?.pagination,
    };
  }

  const { data } = await client.get<MovieResponse>(`/v1/api/the-loai/${slug}`, {
    params: {
      page: params.page || 1,
      limit: params.limit || 24,
      country: params.type === "japan" ? "nhat-ban" : params.type === "china" ? "trung-quoc" : undefined,
      sort_field: "modified.time",
      sort_type: "desc",
      sort_lang: "vietsub",
    },
  });
  const cdn = data.data?.APP_DOMAIN_CDN_IMAGE || DEFAULT_IMAGE_CDN;
  const items = unwrapItems<Movie>(data)
    .map((movie) => normalizeMovie(movie, cdn))
    .filter(isAnimeOrDonghua);

  return {
    items,
    pagination: data.pagination || data.data?.params?.pagination || data.params?.pagination,
  };
}

function readableText(value?: string) {
  if (!value) return "";
  let text = value;

  if (/(Ã|Ä|Æ|áº|á»)/.test(text)) {
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

function cleanSeriesTitle(value?: string) {
  return readableText(value)
    .toLocaleLowerCase("vi-VN")
    .replace(/\([^)]*(phần|phan|season|ss|s\d+)[^)]*\)/gi, " ")
    .replace(/\b(phần|phan|season)\s*\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function relatedKeyword(movie: Movie) {
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

function isSameSeries(baseTitles: string[], item: Movie) {
  const itemTitles = [cleanSeriesTitle(item.name), cleanSeriesTitle(item.origin_name)].filter(Boolean);
  return baseTitles.some((baseTitle) =>
    itemTitles.some((itemTitle) => itemTitle === baseTitle || itemTitle.startsWith(`${baseTitle} `) || itemTitle.includes(` ${baseTitle} `)),
  );
}

export async function getRelatedMovies(movie: Movie, limit = 8) {
  const keyword = cleanSeriesTitle(normalizeRelatedKeyword(relatedKeyword(movie)));
  const baseTitles = [cleanSeriesTitle(movie.name), cleanSeriesTitle(movie.origin_name)].filter((title) => title.length >= 3);
  const seen = new Set([movie.slug]);
  const related: Movie[] = [];

  function append(items: Movie[]) {
    for (const item of items) {
      if (seen.has(item.slug)) continue;
      if (!isSameSeries(baseTitles, item)) continue;
      seen.add(item.slug);
      related.push(item);
      if (related.length >= limit) break;
    }
  }

  if (keyword.length >= 3) {
    try {
      append(await searchMovies(keyword));
    } catch {
      return [];
    }
  }

  return related.slice(0, limit);
}

export async function searchMovies(keyword: string) {
  const { data } = await client.get<MovieResponse>("/v1/api/tim-kiem", {
    params: { keyword, page: 1, sort_lang: "vietsub" },
  });
  const cdn = data.data?.APP_DOMAIN_CDN_IMAGE || DEFAULT_IMAGE_CDN;
  return unwrapItems<Movie>(data)
    .map((movie) => normalizeMovie(movie, cdn))
    .filter(isAnimeOrDonghua);
}

export async function getCategories(type: string = "all") {
  const sources: Array<{ source: CategorySource; path: string }> = [
    { source: "hh3d", path: "/api/hh3d/the-loai" },
    { source: "hhpanda", path: "/api/hhpanda/the-loai" },
  ];
  const results = await Promise.allSettled(sources.map((source) => localClient.get<MovieResponse | Taxonomy[]>(source.path)));

  return results.flatMap((result, index) => {
    if (result.status !== "fulfilled") return [];
    const source = sources[index].source;
    return unwrapItems<Taxonomy>(result.value.data)
      .filter((item) => !isBlockedTaxonomy(item))
      .map((item) => categoryFromSource(item, source));
  });
}

export async function getCountries() {
  const { data } = await client.get<MovieResponse | Taxonomy[]>("/quoc-gia");
  return unwrapItems<Taxonomy>(data);
}

export async function getMovieDetail(slug: string) {
  const sourceMovie = parseCategorySlug(slug);

  if (sourceMovie.source === "hh3d" || sourceMovie.source === "hhpanda") {
    const { data } = await localClient.get<MovieDetailResponse>(`/api/${sourceMovie.source}/phim/${sourceMovie.slug}`);
    const movie = data.movie || data.data?.movie;

    return {
      movie: movie ? movieFromSource(movie, sourceMovie.source) : undefined,
      episodes: data.episodes || data.data?.episodes || [],
    };
  }

  const { data } = await client.get<MovieDetailResponse>(`/phim/${slug}`);
  let movie = data.movie || data.data?.movie;

  return {
    movie: movie ? normalizeMovie(movie) : undefined,
    episodes: data.episodes || data.data?.episodes || [],
  };
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
