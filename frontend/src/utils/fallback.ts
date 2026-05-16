import type { Movie, Taxonomy } from "../@types/movie";

export const fallbackMovies: Movie[] = [
  {
    _id: 1,
    name: "Thần Mộ",
    origin_name: "Shen Mu",
    slug: "than-mo",
    poster_url: "https://phimimg.com/upload/vod/20240810-1/70450ee2d5f43f5d283fdb68b0d0bff9.jpg",
    thumb_url: "https://phimimg.com/upload/vod/20240810-1/70450ee2d5f43f5d283fdb68b0d0bff9.jpg",
    year: 2024,
    type: "hoathinh",
    category: [{ name: "Hoạt Hình", slug: "hoat-hinh" }],
    country: [{ name: "Trung Quốc", slug: "trung-quoc" }],
    tmdb: { vote_average: "8.0", vote_count: 1, type: "tv" },
  },
  {
    _id: 2,
    name: "Tiên Nghịch",
    origin_name: "Renegade Immortal",
    slug: "tien-nghich",
    poster_url: "https://phimimg.com/upload/vod/20240120-1/18b5de0b483d9b50480a70b4a8e5a58f.jpg",
    thumb_url: "https://phimimg.com/upload/vod/20240120-1/18b5de0b483d9b50480a70b4a8e5a58f.jpg",
    year: 2023,
    type: "hoathinh",
    category: [{ name: "Hoạt Hình", slug: "hoat-hinh" }],
    country: [{ name: "Trung Quốc", slug: "trung-quoc" }],
    tmdb: { vote_average: "8.5", vote_count: 1, type: "tv" },
  },
  {
    _id: 3,
    name: "Dược Sư Tự Sự",
    origin_name: "The Apothecary Diaries",
    slug: "duoc-su-tu-su",
    poster_url: "https://phimimg.com/upload/vod/20231022-1/f4d00ee7b0b87c8a0bfa69427e27f08d.jpg",
    thumb_url: "https://phimimg.com/upload/vod/20231022-1/f4d00ee7b0b87c8a0bfa69427e27f08d.jpg",
    year: 2023,
    type: "hoathinh",
    category: [{ name: "Hoạt Hình", slug: "hoat-hinh" }],
    country: [{ name: "Nhật Bản", slug: "nhat-ban" }],
    tmdb: { vote_average: "8.7", vote_count: 1, type: "tv" },
  },
];

export const fallbackCategories: Taxonomy[] = [
  { name: "Hành Động", slug: "hanh-dong" },
  { name: "Lịch Sử", slug: "lich-su" },
  { name: "Viễn Tưởng", slug: "vien-tuong" },
  { name: "Bí Ẩn", slug: "bi-an" },
  { name: "Thể Thao", slug: "the-thao" },
  { name: "Cổ Trang", slug: "co-trang" },
  { name: "Kinh Dị", slug: "kinh-di" },
  { name: "Tình Cảm", slug: "tinh-cam" },
  { name: "Phiêu Lưu", slug: "phieu-luu" },
  { name: "Chiến Tranh", slug: "chien-tranh" },
  { name: "Tài Liệu", slug: "tai-lieu" },
  { name: "Tâm Lý", slug: "tam-ly" },
];

export const fallbackCountries: Taxonomy[] = [
  { name: "Việt Nam", slug: "viet-nam" },
  { name: "Trung Quốc", slug: "trung-quoc" },
  { name: "Nhật Bản", slug: "nhat-ban" },
];
