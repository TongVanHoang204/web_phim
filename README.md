# Web Phim TSPHIM

Ứng dụng xem phim tách `frontend` và `backend`.

- Frontend: React, Vite, TypeScript, Framer Motion
- Backend: Express proxy chạy port `8081`
- API nguồn chính: `https://phimapi.com`
- Player chính: `link_m3u8` phát bằng HLS trong thẻ `<video>`
- API nguồn HH3D dự phòng: `https://hh3d.io`
- API nguồn HHPANDA dự phòng: `https://hhpanda.st/wp-json`

## Chạy local

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

```bash
cd frontend
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend health check: `http://localhost:8081/api/health`

Ví dụ route xem phim realtime:

```txt
http://127.0.0.1:5173/phim/gia-thien
http://127.0.0.1:5173/xem-phim/gia-thien
```

PhimAPI trả `link_embed` và `link_m3u8`; app ưu tiên `link_m3u8` để chỉ nhúng video/tập, không nhúng cả HTML/CSS của trang nguồn.
