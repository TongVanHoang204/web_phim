export type Movie = {
  _id?: number | string;
  name: string;
  origin_name?: string;
  slug: string;
  poster_url?: string;
  thumb_url?: string;
  year?: number;
  view?: number;
  tmdb?: {
    vote_average?: string | number;
    vote_count?: string | number;
    type?: string;
  };
  quality?: string;
  episode_current?: string;
  episode_total?: string;
  content?: string;
  created?: {
    time?: string;
  };
  modified?: {
    time?: string;
  };
  type?: string;
  status?: string;
  time?: string;
  lang?: string;
  actor?: string[];
  director?: string[];
  category?: Taxonomy[];
  country?: Taxonomy[];
  source?: "hhkungfu" | "animehay";
};

export type EpisodeItem = {
  _id?: string;
  name: string;
  slug: string;
  filename?: string;
  link_embed: string;
  fallback_embed?: string;
  source_url?: string;
  link_m3u8?: string;
  open_external?: boolean;
  cut_ranges?: VideoCutRange[];
};

export type VideoCutRange = {
  start: number;
  end: number;
  label?: string;
};

export type EpisodeServer = {
  server_name: string;
  server_data: EpisodeItem[];
};

export type Taxonomy = {
  _id?: number;
  name: string;
  slug: string;
  source?: "hhkungfu" | "animehay";
};

export type MovieResponse = {
  status?: boolean | string;
  items?: Movie[];
  data?: {
    items?: Movie[] | Taxonomy[];
    APP_DOMAIN_CDN_IMAGE?: string;
    params?: {
      pagination?: MovieResponse["pagination"];
    };
  };
  params?: {
    pagination?: MovieResponse["pagination"];
  };
  pagination?: {
    totalItems?: number;
    totalItemsPerPage?: number;
    currentPage?: number;
    totalPages?: number;
  };
};

export type MovieDetailResponse = {
  status?: boolean | string;
  msg?: string;
  movie?: Movie;
  episodes?: EpisodeServer[];
  data?: {
    movie?: Movie;
    episodes?: EpisodeServer[];
  };
};
