import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import Hls from "hls.js";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Film,
  Flame,
  Globe2,
  History,
  Info,
  Loader2,
  Maximize2,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Star,
  TrendingUp,
  Tv,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  getCategories,
  getCountries,
  getLatestMovies,
  getMovieDetail,
  getMovies,
  getMoviesByCategory,
  getWatchHistory,
  getRelatedMovies,
  saveWatchHistoryEntry,
  searchMovies,
} from "./api/movieApi";
import type { EpisodeItem, Movie, Taxonomy } from "./@types/movie";
import tsverseLogo from "./assets/tsverse-logo-transparent.svg";
import { fallbackCategories, fallbackCountries, fallbackMovies } from "./utils/fallback";

type HeaderFilter = "all" | "china" | "japan";

type WatchHistoryItem = {
  name: string;
  origin_name?: string;
  slug: string;
  poster_url?: string;
  thumb_url?: string;
  episodeName?: string;
  watchedAt: number;
};

type PaginationInfo = {
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  totalItemsPerPage?: number;
};

const DEFAULT_PAGINATION: PaginationInfo = {
  currentPage: 1,
  totalPages: 1,
};
const HOME_MOVIE_DISPLAY_LIMIT = 20;
const HOME_MOVIE_FETCH_LIMIT = 40;
const AD_SKIP_START_SECONDS = 14 * 60 + 58;
const AD_SKIP_END_SECONDS = 15 * 60 + 35;

const navItems: Array<{ label: string; filter?: HeaderFilter; path?: string; href?: string; isDropdown?: boolean }> = [
  { label: "Trang chủ", filter: "all", path: "/" },
  { label: "Anime", filter: "japan", path: "/anime" },
  { label: "3D", filter: "china", path: "/3d" },
  { label: "Thể loại", isDropdown: true },
];

function rating(movie: Movie) {
  const value = Number(movie.tmdb?.vote_average || 0);
  return Number.isFinite(value) && value > 0 ? value.toFixed(1) : "N/A";
}

function ratingCount(movie: Movie) {
  const value = Number(movie.tmdb?.vote_count || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function compactNumber(value?: number) {
  if (!value) return "";
  return new Intl.NumberFormat("vi-VN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, entity) => namedEntities[entity.toLowerCase()] ?? match);
}

function displayText(value?: string) {
  if (!value) return "";
  let text = value;

  if (/(Ã|Ä|Æ|áº|á»)/.test(text)) {
    try {
      const bytes = Uint8Array.from(Array.from(text), (char) => char.charCodeAt(0) & 0xff);
      const decoded = new TextDecoder("utf-8").decode(bytes);
      if (!decoded.includes("�")) text = decoded;
    } catch {
      return decodeHtmlEntities(text);
    }
  }

  return decodeHtmlEntities(decodeHtmlEntities(text));
}

function statusLabel(value?: string) {
  if (!value) return "Đang cập nhật";
  const normalized = displayText(value).toLowerCase();
  if (["ongoing", "dang-chieu", "đang chiếu"].includes(normalized)) return "Đang chiếu";
  if (["completed", "complete", "hoan-tat", "hoàn tất"].includes(normalized)) return "Hoàn tất";
  return displayText(value);
}

function poster(movie: Movie | WatchHistoryItem) {
  return movie.poster_url || movie.thumb_url || "";
}

function backdrop(movie: Movie) {
  return movie.thumb_url || movie.poster_url || "";
}

function movieKind(movie: Movie) {
  const country = displayText(movie.country?.[0]?.name);
  return country === "Trung Quốc" ? "Donghua" : "Anime";
}

function episodeBadge(movie: Movie) {
  const current = displayText(movie.episode_current).trim();
  const value = current || displayText(movie.episode_total).trim();
  if (!value) return "";
  if (current && current.includes("/")) return current.split("/")[0].trim();
  if (/full/i.test(value)) return "Full";
  if (/(tập|tp|tap|episode|ep)/i.test(value)) return value;
  return `Tập ${value}`;
}
function formatMovieDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function movieUpdatedDate(movie: Movie) {
  return formatMovieDate(movie.modified?.time || movie.created?.time);
}

function starRating(movie: Movie) {
  const value = Number(movie.tmdb?.vote_average || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  const stars = Math.max(0, Math.min(5, Math.round(value / 2)));
  return "★★★★★".slice(0, stars) + "☆☆☆☆☆".slice(stars);
}

function loadLocalWatchHistory() {
  try {
    const raw = localStorage.getItem("watchHistory");
    return raw ? (JSON.parse(raw) as WatchHistoryItem[]) : [];
  } catch {
    return [];
  }
}

function cacheWatchHistory(items: WatchHistoryItem[]) {
  localStorage.setItem("watchHistory", JSON.stringify(items));
}

async function loadWatchHistory() {
  try {
    const items = await getWatchHistory();
    cacheWatchHistory(items);
    return items;
  } catch {
    return loadLocalWatchHistory();
  }
}

function saveWatchHistory(movie: Movie, episode: EpisodeItem) {
  const nextItem: WatchHistoryItem = {
    name: movie.name,
    origin_name: movie.origin_name,
    slug: movie.slug,
    poster_url: movie.poster_url,
    thumb_url: movie.thumb_url,
    episodeName: episode.name,
    watchedAt: Date.now(),
  };
  const localNext = [nextItem, ...loadLocalWatchHistory().filter((item) => item.slug !== movie.slug)].slice(0, 12);
  cacheWatchHistory(localNext);
  void saveWatchHistoryEntry(nextItem)
    .then((items) => cacheWatchHistory(items))
    .catch(() => undefined);
}

function useHomeData(initialFilter: HeaderFilter) {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [categories, setCategories] = useState<Taxonomy[]>([]);
  const [countries, setCountries] = useState<Taxonomy[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>(DEFAULT_PAGINATION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const [latest, categoryItems, countryItems] = await Promise.all([
          initialFilter === "all" ? getLatestMovies() : getMovies({ type: initialFilter, page: 1, limit: HOME_MOVIE_FETCH_LIMIT }),
          getCategories(initialFilter),
          getCountries(),
        ]);

        if (!mounted) return;
        setMovies(latest.items.length ? latest.items : fallbackMovies);
        setPagination(latest.pagination || DEFAULT_PAGINATION);
        setCategories(categoryItems.length ? categoryItems.slice(0, 14) : fallbackCategories);
        setCountries(countryItems.length ? countryItems.slice(0, 10) : fallbackCountries);
      } catch (err) {
        if (!mounted) return;
        setMovies(fallbackMovies);
        setPagination(DEFAULT_PAGINATION);
        setCategories(fallbackCategories);
        setCountries(fallbackCountries);
        setError("Không thể tải API trực tiếp, đang hiển thị dữ liệu dự phòng.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [initialFilter]);

  return { movies, categories, countries, pagination, loading, error, setMovies, setPagination, setError };
}

function Header({
  query,
  onQueryChange,
  onSubmit,
  activeFilter,
  onFilter,
  categories = fallbackCategories,
  activeCategory,
  onCategory,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  activeFilter?: string;
  onFilter?: (value: HeaderFilter) => void;
  categories?: Taxonomy[];
  activeCategory?: string;
  onCategory?: (category: Taxonomy) => void;
}) {
  const menuCategories = categories.length ? categories : fallbackCategories;

  return (
    <header className="site-header">
      <Link className="brand" to="/">
        <img className="brand-logo" src={tsverseLogo} alt="TSVERSE" />
      </Link>

      <nav className="nav">
        {navItems.map((item, index) => {
          if (item.isDropdown) {
            return (
              <div key={item.label} className="nav-dropdown">
                <button className={activeCategory ? "active" : ""} type="button">
                  {item.label}
                </button>
                <div className="dropdown-menu">
                  {menuCategories.slice(0, 14).map((cat) =>
                    onCategory ? (
                      <button
                        className={activeCategory === cat.slug ? "selected" : ""}
                        key={cat.slug}
                        onClick={() => {
                          onCategory(cat);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                        type="button"
                      >
                        {displayText(cat.name)}
                      </button>
                    ) : (
                      <Link key={cat.slug} to="/#bo-loc">
                        {displayText(cat.name)}
                      </Link>
                    ),
                  )}
                </div>
              </div>
            );
          }

          if (item.filter && item.path) {
            return (
              <Link
                className={activeFilter === item.filter || (!activeFilter && index === 0) ? "active" : ""}
                key={`${item.label}-${item.filter}`}
                to={item.path}
              >
                {item.label}
              </Link>
            );
          }

          if (item.filter) {
            return (
              <Link key={`${item.label}-${item.filter}`} to="/">
                {item.label}
              </Link>
            );
          }

          return (
            <a href={item.href} key={item.label}>
              {item.label}
            </a>
          );
        })}
      </nav>

      <form
        className="search"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Search size={18} />
        <input
          aria-label="Tìm phim"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Tìm phim..."
        />
      </form>
    </header>
  );
}

function Hero({ movies, selected, onSelect }: { movies: Movie[]; selected: Movie; onSelect: (movie: Movie) => void }) {
  const spotlight = movies.slice(0, 4);

  return (
    <>
      <div className="project-notice">Đây là đồ án giúp em qua môn nên mong cơ quan nhà nước đừng phạt em :&gt;</div>
      <section className="hero">
        <motion.div
          className="hero-backdrop"
          key={selected.slug}
          initial={{ opacity: 0.3, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7 }}
          style={{ backgroundImage: `url(${backdrop(selected)})` }}
        />
        <div className="hero-shade" />

        <motion.div
          className="hero-copy"
          initial={{ y: 18, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.55 }}
        >
          <h1>{displayText(selected.name)}</h1>
          <p>{displayText(selected.origin_name) || "Kho phim trực tuyến cập nhật nhanh với giao diện hiện đại."}</p>
          <div className="hero-meta">
            <span>
              <Star size={16} fill="currentColor" /> {rating(selected)}
            </span>
            <span>{selected.year || "Đang cập nhật"}</span>
            <span>{movieKind(selected)}</span>
          </div>
          <div className="actions">
            <Link className="primary-button" to={`/xem-phim/${selected.slug}`}>
              <Play size={18} fill="currentColor" /> Xem ngay
            </Link>
            <Link className="ghost-button" to={`/phim/${selected.slug}`}>
              <Info size={18} /> Chi tiết
            </Link>
          </div>
        </motion.div>

        <div className="spotlight-stack" aria-label="Phim nổi bật">
          {spotlight.map((movie) => (
            <button
              className={movie.slug === selected.slug ? "poster-button selected" : "poster-button"}
              key={movie.slug}
              onClick={() => onSelect(movie)}
              type="button"
              title={displayText(movie.name)}
            >
              <img src={poster(movie)} alt={displayText(movie.name)} />
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function FilterPanel({
  categories,
  countries,
  filter,
  onFilter,
  activeCategory,
  onCategoryFilter,
}: {
  categories: Taxonomy[];
  countries: Taxonomy[];
  filter: string;
  onFilter: (value: HeaderFilter) => void;
  activeCategory: string;
  onCategoryFilter: (category: Taxonomy) => void;
}) {
  const years = ["2026", "2025", "2024", "2023"];
  const relatedMovies: Movie[] = [];

  return (
    <section className="filter-panel" id="bo-loc">
      <div className="filter-title">
        <SlidersHorizontal size={20} />
        Bộ lọc nhanh
      </div>
      <div className="filter-groups">
        <div className="segmented" aria-label="Lọc nhanh theo loại phim">
          {[
            ["all", "Tất cả"],
            ["china", "Donghua Trung Quốc"],
            ["japan", "Anime Nhật Bản"],
          ].map(([value, label]) => (
            <button className={filter === value ? "selected" : ""} key={label} onClick={() => onFilter(value as HeaderFilter)} type="button">
              {label}
            </button>
          ))}
        </div>
        <div className="chips" aria-label="Thể loại nổi bật">
          {categories.slice(0, 7).map((item) => (
            <button
              className={activeCategory === item.slug ? "selected" : ""}
              key={item.slug}
              onClick={() => onCategoryFilter(item)}
              type="button"
            >
              {displayText(item.name)}
            </button>
          ))}
        </div>
        <div className="chips subdued" aria-label="Quốc gia và năm nổi bật">
          {countries.slice(0, 5).map((item) => (
            <span key={item.slug}>
              <Globe2 size={13} /> {displayText(item.name)}
            </span>
          ))}
          {years.map((year) => (
            <span key={year}>{year}</span>
          ))}
        </div>
        {relatedMovies.length ? (
          <section className="related-section">
            <h2>Phim liên quan</h2>
            <div className="related-grid">
              {relatedMovies.map((item, index) => (
                <MovieCard index={index} key={item.slug} movie={item} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function MovieCard({ movie, index }: { movie: Movie; index: number }) {
  const badge = episodeBadge(movie);

  return (
    <motion.article
      className="movie-card"
      initial={{ y: 24, opacity: 0 }}
      whileInView={{ y: 0, opacity: 1 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ delay: Math.min(index * 0.03, 0.24), duration: 0.45 }}
    >
      <div className="poster-frame">
        <Link className="poster-image-link" to={`/phim/${movie.slug}`} aria-label={`Chi tiết ${displayText(movie.name)}`}>
          <img src={poster(movie)} alt={displayText(movie.name)} loading="lazy" />
        </Link>
        {badge ? <span className="episode-badge">{badge}</span> : null}
      </div>
      <div className="movie-info">
        <h3>
          <Link to={`/phim/${movie.slug}`}>{displayText(movie.name)}</Link>
        </h3>
        <p>{displayText(movie.origin_name) || "Đang cập nhật"}</p>
        <div>
          <span>{movie.year || "N/A"}</span>
          <span>
            <Star size={13} fill="currentColor" /> {rating(movie)}
          </span>
        </div>
      </div>
    </motion.article>
  );
}

function PaginationControls({
  pagination,
  busy,
  onPageChange,
}: {
  pagination: PaginationInfo;
  busy: boolean;
  onPageChange: (page: number) => void;
}) {
  const currentPage = Number(pagination.currentPage || 1);
  const totalPages = Number(pagination.totalPages || 1);

  if (totalPages <= 1) return null;

  const pages = Array.from(
    new Set([1, currentPage - 1, currentPage, currentPage + 1, totalPages].filter((page) => page >= 1 && page <= totalPages)),
  );

  return (
    <nav className="pagination" aria-label="Phân trang phim">
      <button disabled={busy || currentPage <= 1} onClick={() => onPageChange(currentPage - 1)} type="button">
        Trước
      </button>
      {pages.map((page, index) => {
        const previous = pages[index - 1];
        return (
          <span className="page-group" key={page}>
            {previous && page - previous > 1 ? <span className="page-ellipsis">...</span> : null}
            <button className={page === currentPage ? "selected" : ""} disabled={busy} onClick={() => onPageChange(page)} type="button">
              {page}
            </button>
          </span>
        );
      })}
      <button disabled={busy || currentPage >= totalPages} onClick={() => onPageChange(currentPage + 1)} type="button">
        Sau
      </button>
    </nav>
  );
}

function SideRail({ trending, history }: { trending: Movie[]; history: WatchHistoryItem[] }) {
  return (
    <aside className="side-rail">
      <section className="rail-panel">
        <h3>
          <TrendingUp size={18} /> Xem nhiều nhất
        </h3>
        <div className="rail-list">
          {trending.slice(0, 7).map((movie, index) => (
            <Link className="rail-item" key={`${movie.slug}-${index}`} to={`/phim/${movie.slug}`}>
              <span className="rail-rank">{index + 1}</span>
              <img className="rail-thumb" src={poster(movie)} alt={displayText(movie.name)} loading="lazy" />
              <span className="rail-meta">
                <strong>{displayText(movie.name)}</strong>
                <small>{movie.episode_current || movie.year || movieKind(movie)}</small>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="rail-panel">
        <h3>
          <History size={18} /> Lịch sử xem
        </h3>
        {history.length ? (
          <div className="rail-list">
            {history.map((item) => (
              <Link className="rail-item" key={`${item.slug}-${item.watchedAt}`} to={`/phim/${item.slug}`}>
                <img className="rail-thumb" src={poster(item)} alt={displayText(item.name)} loading="lazy" />
                <span className="rail-meta">
                  <strong>{displayText(item.name)}</strong>
                  <small>{displayText(item.episodeName) || displayText(item.origin_name) || "Tiếp tục xem"}</small>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="rail-empty">Chưa có lịch sử xem.</p>
        )}
      </section>
    </aside>
  );
}

function flattenEpisodes(servers: { server_name: string; server_data: EpisodeItem[] }[]) {
  return servers.flatMap((server) =>
    server.server_data.map((episode) => ({
      ...episode,
      serverName: server.server_name,
    })),
  );
}

function cleanServerName(name: string) {
  const cleanName = displayText(name);
  return cleanName.replace(/^#?\s*Hà Nội\s*/i, "").trim() || cleanName;
}

function episodeNumber(episode: EpisodeItem) {
  const value = displayText(episode.name || episode.slug);
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function newestEpisodesFirst(episodes: EpisodeItem[]) {
  return [...episodes].sort((a, b) => episodeNumber(b) - episodeNumber(a));
}

function latestEpisodeFrom<T extends EpisodeItem>(episodes: T[]) {
  return newestEpisodesFirst(episodes)[0] as T | undefined;
}

function adSkipDuration() {
  return AD_SKIP_END_SECONDS - AD_SKIP_START_SECONDS;
}

function visibleDurationFromActual(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return duration > AD_SKIP_END_SECONDS ? duration - adSkipDuration() : duration;
}

function visibleTimeFromActual(time: number, duration: number) {
  if (!Number.isFinite(time) || time <= 0) return 0;
  if (duration <= AD_SKIP_START_SECONDS || time < AD_SKIP_END_SECONDS) return Math.min(time, visibleDurationFromActual(duration));
  return Math.min(time - adSkipDuration(), visibleDurationFromActual(duration));
}

function actualTimeFromVisible(time: number, duration: number) {
  if (!Number.isFinite(time) || time <= 0) return 0;
  if (duration <= AD_SKIP_START_SECONDS || time < AD_SKIP_START_SECONDS) return time;
  return Math.min(time + adSkipDuration(), duration || time);
}

function formatPlayerTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function RelatedMoviesPanel({ movies }: { movies: Movie[] }) {
  return (
    <section className="detail-related-panel">
      <h2>Phim liên quan</h2>
      {movies.length ? (
        <div>
          {movies.slice(0, 8).map((item) => (
            <Link className="detail-related-item" key={item.slug} to={`/phim/${item.slug}`}>
              <img src={poster(item)} alt={displayText(item.name)} loading="lazy" />
              <span>
                <strong>{displayText(item.name)}</strong>
                <small>{episodeBadge(item) || item.year || movieKind(item)}</small>
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="detail-related-empty">Đang tìm phim cùng thể loại...</p>
      )}
    </section>
  );
}

function HlsVideoPlayer({
  episode,
  title,
  hasNextEpisode,
  hasPreviousEpisode,
  onNextEpisode,
  onPreviousEpisode,
}: {
  episode: EpisodeItem;
  title: string;
  hasNextEpisode: boolean;
  hasPreviousEpisode: boolean;
  onNextEpisode: () => void;
  onPreviousEpisode: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hideControlsTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [hlsError, setHlsError] = useState("");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  function clearHideControlsTimer() {
    if (hideControlsTimer.current) {
      window.clearTimeout(hideControlsTimer.current);
      hideControlsTimer.current = null;
    }
  }

  function showControlsTemporarily(force = false) {
    const video = videoRef.current;
    clearHideControlsTimer();
    setControlsVisible(true);

    if (force || !video || video.paused) return;
    hideControlsTimer.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, 2400);
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    showControlsTemporarily(true);
    if (video.paused) {
      void video.play().catch(() => undefined);
      return;
    }
    video.pause();
  }

  function seekToVisibleTime(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = actualTimeFromVisible(value, duration);
    setCurrentTime(video.currentTime);
    showControlsTemporarily();
  }

  function skipBy(seconds: number) {
    const video = videoRef.current;
    if (!video) return;
    const nextVisibleTime = Math.max(0, Math.min(visibleTimeFromActual(video.currentTime, duration) + seconds, visibleDurationFromActual(duration)));
    seekToVisibleTime(nextVisibleTime);
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
    showControlsTemporarily();
  }

  function changeVolume(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    setVolume(value);
    setMuted(video.muted);
    showControlsTemporarily();
  }

  async function toggleFullscreen() {
    const video = videoRef.current;
    const frame = video?.closest(".player-frame") as HTMLElement | null;
    if (!frame) return;

    showControlsTemporarily(true);
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    await frame.requestFullscreen().catch(() => undefined);
  }

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      const element = target as HTMLElement | null;
      if (!element) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

      event.preventDefault();
      skipBy(event.key === "ArrowLeft" ? -10 : 10);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [duration]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const player = video;

    function skipMidrollAd() {
      if (player.currentTime >= AD_SKIP_START_SECONDS && player.currentTime < AD_SKIP_END_SECONDS) {
        player.currentTime = AD_SKIP_END_SECONDS;
      }
    }

    player.addEventListener("timeupdate", skipMidrollAd);
    player.addEventListener("seeking", skipMidrollAd);
    return () => {
      player.removeEventListener("timeupdate", skipMidrollAd);
      player.removeEventListener("seeking", skipMidrollAd);
    };
  }, [episode.link_m3u8]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const player = video;

    function syncVideoState() {
      setCurrentTime(player.currentTime || 0);
      setDuration(player.duration || 0);
      setPaused(player.paused);
      setMuted(player.muted);
      setVolume(player.volume);
    }

    function handlePlay() {
      setPaused(false);
      showControlsTemporarily();
    }

    function handlePause() {
      setPaused(true);
      showControlsTemporarily(true);
    }

    function keepControlsVisible() {
      showControlsTemporarily(true);
    }

    function revealControlsBriefly() {
      showControlsTemporarily();
    }

    player.addEventListener("loadedmetadata", syncVideoState);
    player.addEventListener("durationchange", syncVideoState);
    player.addEventListener("timeupdate", syncVideoState);
    player.addEventListener("play", handlePlay);
    player.addEventListener("pause", handlePause);
    player.addEventListener("volumechange", syncVideoState);
    player.addEventListener("waiting", keepControlsVisible);
    player.addEventListener("seeking", revealControlsBriefly);
    player.addEventListener("seeked", revealControlsBriefly);
    syncVideoState();

    return () => {
      clearHideControlsTimer();
      player.removeEventListener("loadedmetadata", syncVideoState);
      player.removeEventListener("durationchange", syncVideoState);
      player.removeEventListener("timeupdate", syncVideoState);
      player.removeEventListener("play", handlePlay);
      player.removeEventListener("pause", handlePause);
      player.removeEventListener("volumechange", syncVideoState);
      player.removeEventListener("waiting", keepControlsVisible);
      player.removeEventListener("seeking", revealControlsBriefly);
      player.removeEventListener("seeked", revealControlsBriefly);
    };
  }, [episode.link_m3u8]);

  useEffect(() => {
    const video = videoRef.current;
    const source = episode.link_m3u8;
    setHlsError("");

    if (!video || !source) return undefined;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setHlsError("Không thể phát HLS, đang chuyển sang player dự phòng.");
      });
      return () => hls.destroy();
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = source;
    } else {
      setHlsError("Trình duyệt không hỗ trợ HLS.");
    }

    return undefined;
  }, [episode.link_m3u8]);

  if (!episode.link_m3u8) {
    return (
      <iframe
        src={episode.link_embed}
        aria-label={title}
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
      />
    );
  }

  return (
    <div
      className={controlsVisible || paused ? "custom-player controls-visible" : "custom-player controls-idle"}
      onDoubleClick={toggleFullscreen}
      onMouseMove={() => showControlsTemporarily()}
      onMouseLeave={() => showControlsTemporarily()}
    >
      <video ref={videoRef} aria-label={title} className="native-video" playsInline poster="" onClick={togglePlayback} />
      <button className="player-center-play" onClick={togglePlayback} type="button" aria-label={paused ? "Phát phim" : "Tạm dừng"}>
        {paused ? <Play size={40} fill="currentColor" /> : <Pause size={40} fill="currentColor" />}
      </button>
      <div className="player-controls" onMouseMove={() => showControlsTemporarily(true)}>
        <input
          aria-label="Tua phim"
          className="player-seek"
          max={visibleDurationFromActual(duration)}
          min={0}
          onChange={(event) => seekToVisibleTime(Number(event.currentTarget.value))}
          step={0.1}
          type="range"
          value={visibleTimeFromActual(currentTime, duration)}
        />
        <div className="player-control-row">
          <div className="player-left-controls">
            <button onClick={togglePlayback} type="button" aria-label={paused ? "Phát phim" : "Tạm dừng"}>
              {paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
            </button>
            <button onClick={() => skipBy(-10)} type="button" aria-label="Lùi 10 giây">
              -10s
            </button>
            <button onClick={() => skipBy(10)} type="button" aria-label="Tới 10 giây">
              +10s
            </button>
            <button className="player-episode-button" disabled={!hasPreviousEpisode} onClick={onPreviousEpisode} type="button" aria-label="Tập trước">
              <SkipBack size={16} /> Tập trước
            </button>
            <button className="player-episode-button" disabled={!hasNextEpisode} onClick={onNextEpisode} type="button" aria-label="Tập sau">
              Tập sau <SkipForward size={16} />
            </button>
            <span className="player-time">
              {formatPlayerTime(visibleTimeFromActual(currentTime, duration))} / {formatPlayerTime(visibleDurationFromActual(duration))}
            </span>
          </div>
          <div className="player-right-controls">
            <button onClick={toggleMute} type="button" aria-label={muted ? "Bật âm thanh" : "Tắt âm thanh"}>
              {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <input
              aria-label="Âm lượng"
              className="player-volume"
              max={1}
              min={0}
              onChange={(event) => changeVolume(Number(event.currentTarget.value))}
              step={0.05}
              type="range"
              value={muted ? 0 : volume}
            />
            <button onClick={toggleFullscreen} type="button" aria-label="Toàn màn hình">
              <Maximize2 size={18} />
            </button>
          </div>
        </div>
      </div>
      {hlsError ? (
        <a className="player-fallback" href={episode.link_embed} rel="noreferrer" target="_blank">
          Mở player dự phòng
        </a>
      ) : null}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="loading">
      <Loader2 className="spin" size={26} />
      Đang tải chi tiết phim...
    </div>
  );
}

function MovieDetailPage() {
  const { slug = "" } = useParams();
  const [movie, setMovie] = useState<Movie | null>(null);
  const [episodes, setEpisodes] = useState<ReturnType<typeof flattenEpisodes>>([]);
  const [episodeServers, setEpisodeServers] = useState<{ server_name: string; server_data: EpisodeItem[] }[]>([]);
  const [relatedMovies, setRelatedMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setRelatedMovies([]);
      try {
        const detail = await getMovieDetail(slug);
        if (!mounted) return;
        if (!detail.movie) {
          setError("Không tìm thấy phim.");
          return;
        }
        setMovie(detail.movie);
        setEpisodeServers(detail.episodes);
        setEpisodes(flattenEpisodes(detail.episodes));
        setLoading(false);

        const related = await getRelatedMovies(detail.movie);
        if (mounted) setRelatedMovies(related);
      } catch {
        if (mounted) setError("Không thể tải chi tiết phim.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [slug]);

  if (loading) return <DetailSkeleton />;
  if (error || !movie) return <div className="notice">{error || "Không tìm thấy phim."}</div>;

  const latestEpisode = latestEpisodeFrom(episodes);
  const updatedDate = movieUpdatedDate(movie);
  const categoryText = movie.category?.map((item) => displayText(item.name)).join(", ");
  const voteCount = ratingCount(movie);

  return (
    <>
      <motion.section
        className="detail-layout detail-cinematic"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        style={{
          backgroundImage: `linear-gradient(90deg, rgba(7, 10, 18, 0.9) 0%, rgba(7, 10, 18, 0.72) 42%, rgba(7, 10, 18, 0.5) 100%), linear-gradient(0deg, rgba(7, 10, 18, 0.94), rgba(7, 10, 18, 0.2)), url(${backdrop(movie)})`,
        }}
      >
        <motion.div className="detail-side" initial={{ opacity: 0, x: -18 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1, duration: 0.45 }}>
          <div className="detail-poster">
            <img src={poster(movie)} alt={displayText(movie.name)} />
          </div>
        </motion.div>
        <motion.div className="detail-content" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.16, duration: 0.45 }}>
          <Link className="back-link" to="/">
            <ArrowLeft size={20} /> Trang chủ
          </Link>
          <div className="detail-kicker">
            <span>{movieKind(movie)}</span>
            <span>{movie.year || "Đang cập nhật"}</span>
            <span>{rating(movie)}/10</span>
          </div>
          <h1>{displayText(movie.name)}</h1>
          <p className="origin-name">{displayText(movie.origin_name)}</p>
          <div className="detail-facts">
            {categoryText ? (
              <p>
                <span>Thể loại:</span> <strong className="fact-link">{categoryText}</strong>
              </p>
            ) : null}
            <p>
              <span>Tập mới nhất:</span> <strong className="fact-badge">{episodeBadge(movie) || movie.episode_current || "Đang cập nhật"}</strong>
            </p>
            <p>
              <span>Tình trạng:</span> <strong>{statusLabel(movie.status)}</strong>
            </p>
            {movie.view ? (
              <p>
                <span>Lượt xem:</span> <strong className="fact-badge">{compactNumber(movie.view)}</strong>
              </p>
            ) : null}
            <p className="fact-rating">
              <span>Đánh giá:</span> <strong>{starRating(movie)}</strong> <em>{rating(movie)}/10{voteCount ? ` - (${voteCount} bình chọn)` : ""}</em>
            </p>
            {updatedDate ? (
              <p>
                <span>Cập nhật:</span> <strong>{updatedDate}</strong>
              </p>
            ) : null}
          </div>
          <p className="movie-description">{displayText(movie.content) || "Nội dung đang được cập nhật."}</p>
          <div className="taxonomy-line">
            {movie.category?.map((item) => (
              <span key={item.slug}>{displayText(item.name)}</span>
            ))}
            {movie.country?.map((item) => (
              <span key={item.slug}>{displayText(item.name)}</span>
            ))}
          </div>
          <div className="actions">
            <Link
              className="primary-button"
              to={`/xem-phim/${movie.slug}${latestEpisode ? `?episode=${latestEpisode.slug}&server=${encodeURIComponent(latestEpisode.serverName)}` : ""}`}
            >
              <Play size={18} fill="currentColor" /> Tập mới nhất
            </Link>
            <Link className="ghost-button" to={`/xem-phim/${movie.slug}`}>
              <Film size={18} /> Xem từ đầu
            </Link>
          </div>
        </motion.div>
      </motion.section>

      <motion.section className="detail-bottom-panel" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.45 }}>
        <div className="detail-lower">
          <RelatedMoviesPanel movies={relatedMovies} />
          <div className="episode-list">
            <h2>Danh sách tập</h2>
            <div className="episode-server-groups">
              {episodeServers.map((server) => (
                <section className="episode-server" key={server.server_name}>
                  <h3>{cleanServerName(server.server_name)}</h3>
                  <div>
                    {newestEpisodesFirst(server.server_data).map((episode) => (
                      <Link key={`${server.server_name}-${episode.slug}-${episode.link_embed}`} to={`/xem-phim/${movie.slug}?episode=${episode.slug}`}>
                        {displayText(episode.name)}
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      </motion.section>
    </>
  );
}

function WatchPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [movie, setMovie] = useState<Movie | null>(null);
  const [episodes, setEpisodes] = useState<ReturnType<typeof flattenEpisodes>>([]);
  const [episodeServers, setEpisodeServers] = useState<{ server_name: string; server_data: EpisodeItem[] }[]>([]);
  const [active, setActive] = useState<ReturnType<typeof flattenEpisodes>[number] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const playerFrameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;
    const searchParams = new URLSearchParams(window.location.search);
    const episodeSlug = searchParams.get("episode");
    const serverName = searchParams.get("server");

    async function load() {
      setLoading(true);
      try {
        const detail = await getMovieDetail(slug);
        const flatEpisodes = flattenEpisodes(detail.episodes);
        const selectedEpisode =
          flatEpisodes.find((item) => item.slug === episodeSlug && (!serverName || item.serverName === serverName)) ||
          flatEpisodes.find((item) => item.slug === episodeSlug) ||
          latestEpisodeFrom(flatEpisodes) ||
          null;

        if (!mounted) return;
        if (!detail.movie || !selectedEpisode) {
          setError("Phim này chưa có link xem.");
          return;
        }
        setMovie(detail.movie);
        setEpisodes(flatEpisodes);
        setEpisodeServers(detail.episodes);
        setActive(selectedEpisode);
        saveWatchHistory(detail.movie, selectedEpisode);
      } catch {
        if (mounted) setError("Không thể tải player.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [slug]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      const element = target as HTMLElement | null;
      if (!element) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable;
    }

    async function togglePlayerFullscreen() {
      const playerFrame = playerFrameRef.current;
      if (!playerFrame) return;

      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
        return;
      }

      await playerFrame.requestFullscreen().catch(() => undefined);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "f" || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
      event.preventDefault();
      void togglePlayerFullscreen();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (loading) return <DetailSkeleton />;
  if (error || !movie || !active) return <div className="notice">{error || "Không thể mở phim."}</div>;

  const currentServerEpisodes = [...episodes]
    .filter((episode) => episode.serverName === active.serverName)
    .sort((a, b) => episodeNumber(a) - episodeNumber(b));
  const activeIndex = currentServerEpisodes.findIndex((episode) => episode.link_embed === active.link_embed);
  const previousEpisode = activeIndex > 0 ? currentServerEpisodes[activeIndex - 1] : null;
  const nextEpisode = activeIndex >= 0 && activeIndex < currentServerEpisodes.length - 1 ? currentServerEpisodes[activeIndex + 1] : null;

  function selectEpisode(episode: ReturnType<typeof flattenEpisodes>[number]) {
    if (!movie) return;
    setActive(episode);
    saveWatchHistory(movie, episode);
    navigate(`/xem-phim/${movie.slug}?episode=${episode.slug}&server=${encodeURIComponent(episode.serverName)}`, { replace: true });
  }

  return (
    <motion.section
      className="watch-layout watch-cinema"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, ease: "easeOut" }}
      style={{
        backgroundImage: `linear-gradient(90deg, rgba(5, 8, 15, 0.94), rgba(5, 8, 15, 0.78)), linear-gradient(0deg, rgba(5, 8, 15, 0.94), rgba(5, 8, 15, 0.44)), url(${backdrop(movie)})`,
      }}
    >
      <div className="watch-header">
        <Link className="back-link" to={`/phim/${movie.slug}`}>
          <ArrowLeft size={18} /> Chi tiết phim
        </Link>
        <div className="watch-title-block">
          <span>{displayText(active.serverName)}</span>
          <h1>{displayText(movie.name)}</h1>
          <p>{displayText(active.name)}</p>
        </div>
      </div>

      <div className="watch-stage">
        <motion.div
          className="player-frame"
          ref={playerFrameRef}
          initial={{ opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.08, duration: 0.42 }}
        >
          {active.open_external ? (
            <div className="external-player">
              <Play size={42} fill="currentColor" />
              <h2>Nguồn này không cho phát trực tiếp</h2>
              <p>Tập phim sẽ mở trên trang nguồn gốc để tránh lỗi player.</p>
              <a className="primary-button" href={active.link_embed} rel="noreferrer" target="_blank">
                <Play size={18} fill="currentColor" /> Mở tập phim
              </a>
            </div>
          ) : (
            <HlsVideoPlayer
              episode={active}
              title={`${displayText(movie.name)} - ${displayText(active.name)}`}
              hasNextEpisode={Boolean(nextEpisode)}
              hasPreviousEpisode={Boolean(previousEpisode)}
              onNextEpisode={() => nextEpisode && selectEpisode(nextEpisode)}
              onPreviousEpisode={() => previousEpisode && selectEpisode(previousEpisode)}
            />
          )}
        </motion.div>

        <aside className="watch-sidebar">
          <div className="watch-now">
            <img src={poster(movie)} alt={displayText(movie.name)} />
            <div>
              <span>Đang xem</span>
              <strong>{displayText(active.name)}</strong>
              <small>{displayText(movie.name)}</small>
            </div>
          </div>

          <div className="episode-list watch-episodes">
            <h2>Tập phim</h2>
            <div className="episode-server-groups">
              {episodeServers.map((server) => (
                <section className="episode-server" key={server.server_name}>
                  <h3>{cleanServerName(server.server_name)}</h3>
                  <div>
                    {newestEpisodesFirst(server.server_data).map((episode) => {
                      const episodeWithServer = { ...episode, serverName: server.server_name };
                      return (
                        <button
                          className={active.link_embed === episode.link_embed ? "selected" : ""}
                          key={`${server.server_name}-${episode.slug}-${episode.link_embed}`}
                          onClick={() => selectEpisode(episodeWithServer)}
                          type="button"
                        >
                          {displayText(episode.name)}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </motion.section>
  );
}

function HomePage({ initialFilter = "all" }: { initialFilter?: HeaderFilter }) {
  const { movies, categories, loading, error, pagination, setMovies, setPagination, setError } = useHomeData(initialFilter);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Movie | null>(null);
  const [filter, setFilter] = useState<HeaderFilter>(initialFilter);
  const [activeCategory, setActiveCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyItems, setHistoryItems] = useState<WatchHistoryItem[]>([]);
  const navigate = useNavigate();

  const activeMovie = selected || movies[0] || fallbackMovies[0];
  const featured = useMemo(() => movies.slice(0, HOME_MOVIE_DISPLAY_LIMIT), [movies]);
  const trending = useMemo(() => movies.slice(0, 9), [movies]);

  useEffect(() => {
    if (movies.length && (!selected || !movies.some((movie) => movie.slug === selected.slug))) {
      setSelected(movies[0]);
    }
  }, [movies, selected]);

  useEffect(() => {
    setFilter(initialFilter);
    setActiveCategory("");
    setSelected(null);
  }, [initialFilter]);

  useEffect(() => {
    let mounted = true;

    function syncHistory() {
      void loadWatchHistory().then((items) => {
        if (mounted) setHistoryItems(items);
      });
    }

    syncHistory();
    window.addEventListener("focus", syncHistory);
    return () => {
      mounted = false;
      window.removeEventListener("focus", syncHistory);
    };
  }, []);

  async function handleSearch() {
    const keyword = query.trim();
    if (!keyword) return;
    setBusy(true);
    try {
      const results = await searchMovies(keyword);
      setMovies(results);
      setSelected(results[0] || null);
      setActiveCategory("");
      setPagination(DEFAULT_PAGINATION);
      setError(results.length ? "" : "Không tìm thấy kết quả phù hợp.");
      navigate("/");
    } catch {
      setError("Tìm kiếm thất bại, vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFilter(value: HeaderFilter) {
    setFilter(value);
    setActiveCategory("");
    setBusy(true);
    try {
      const results = await getMovies({ type: value || "all", page: 1, limit: HOME_MOVIE_FETCH_LIMIT });
      setMovies(results.items);
      setSelected(results.items[0] || null);
      setPagination(results.pagination || DEFAULT_PAGINATION);
      setError(results.items.length ? "" : "Không có phim phù hợp với bộ lọc này.");
    } catch {
      setError("Không thể tải bộ lọc này.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCategoryFilter(category: Taxonomy) {
    setActiveCategory(category.slug);
    setFilter(initialFilter);
    setBusy(true);
    try {
      const results = await getMoviesByCategory(category.slug, { type: initialFilter, page: 1, limit: HOME_MOVIE_FETCH_LIMIT });
      setMovies(results.items);
      setSelected(results.items[0] || null);
      setPagination(results.pagination || DEFAULT_PAGINATION);
      setError(results.items.length ? "" : `Không có phim phù hợp với thể loại ${displayText(category.name)}.`);
      navigate(initialFilter === "china" ? "/3d" : initialFilter === "japan" ? "/anime" : "/");
    } catch {
      setError(`Không thể tải thể loại ${displayText(category.name)}.`);
    } finally {
      setBusy(false);
    }
  }

  async function handlePageChange(page: number) {
    if (page < 1 || page === Number(pagination.currentPage || 1)) return;
    setBusy(true);
    try {
      const results = activeCategory
        ? await getMoviesByCategory(activeCategory, { type: initialFilter, page, limit: HOME_MOVIE_FETCH_LIMIT })
        : await getMovies({ type: filter || "all", page, limit: HOME_MOVIE_FETCH_LIMIT });
      setMovies(results.items);
      setSelected(results.items[0] || null);
      setPagination(results.pagination || { ...DEFAULT_PAGINATION, currentPage: page });
      setError(results.items.length ? "" : "Không có phim phù hợp với bộ lọc này.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setError("Không thể tải trang phim này.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header
        query={query}
        onQueryChange={setQuery}
        onSubmit={handleSearch}
        activeFilter={filter}
        categories={categories}
        activeCategory={activeCategory}
        onCategory={handleCategoryFilter}
      />

      <div className="page-shell">
        {loading ? (
          <div className="loading">
            <Loader2 className="spin" size={26} />
            Đang tải dữ liệu phim mới nhất...
          </div>
        ) : (
          <>
            <Hero movies={movies} selected={activeMovie} onSelect={setSelected} />

            {error ? <div className="notice">{error}</div> : null}

            <div className="content-layout">
              <div className="content-main">
                <section className="section-heading">
                  <div>
                    <h2>Phim mới cập nhật</h2>
                  </div>
                </section>

                {busy ? (
                  <div className="inline-loader">
                    <Loader2 className="spin" size={20} />
                    Đang cập nhật danh sách...
                  </div>
                ) : null}

                <section className="movie-grid">
                  {featured.map((movie, index) => (
                    <MovieCard index={index} key={`${movie.slug}-${index}`} movie={movie} />
                  ))}
                </section>
                {!featured.length && !busy ? <div className="notice">Không có phim phù hợp.</div> : null}
                <PaginationControls pagination={pagination} busy={busy} onPageChange={handlePageChange} />
              </div>

              <SideRail trending={trending} history={historyItems} />
            </div>
          </>
        )}
      </div>
    </>
  );
}

function App() {
  const [query, setQuery] = useState("");
  const [headerCategories, setHeaderCategories] = useState<Taxonomy[]>(fallbackCategories);

  useEffect(() => {
    let mounted = true;

    async function loadHeaderCategories() {
      try {
        const items = await getCategories("all");
        if (mounted) setHeaderCategories(items.length ? items.slice(0, 14) : fallbackCategories);
      } catch {
        if (mounted) setHeaderCategories(fallbackCategories);
      }
    }

    loadHeaderCategories();
    return () => {
      mounted = false;
    };
  }, []);

  function noopSearch() {
    return undefined;
  }

  return (
    <main>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/anime" element={<HomePage initialFilter="japan" />} />
        <Route path="/3d" element={<HomePage initialFilter="china" />} />
        <Route
          path="/phim/:slug"
          element={
            <>
              <Header query={query} onQueryChange={setQuery} onSubmit={noopSearch} categories={headerCategories} />
              <div className="page-shell">
                <MovieDetailPage />
              </div>
            </>
          }
        />
        <Route
          path="/xem-phim/:slug"
          element={
            <>
              <Header query={query} onQueryChange={setQuery} onSubmit={noopSearch} categories={headerCategories} />
              <div className="page-shell">
                <WatchPage />
              </div>
            </>
          }
        />
      </Routes>
    </main>
  );
}

export default App;
