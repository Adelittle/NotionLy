# ⚡ NotionLy Go

Aplikasi web ultra-ringan berbasis **Go (Golang)** untuk berbagi catatan secara real-time (collaborative note) dan berbagi file hingga **5 GB** per room.

---

## 🌟 Fitur Utama

1. **Sistem Room-ID (Isolasi Ruangan)**:
   - Sebelum mengakses fitur sharing note dan upload file, pengguna harus memasukkan `room-id` (atau membuat room acak).
   - Seluruh data catatan dan file terisolasi berdasarkan `room-id` masing-masing.

2. **Sharing Note Real-Time (Kolaborasi Teks)**:
   - Pengubahan teks catatan disinkronkan secara instant ke seluruh pengguna dalam room yang sama menggunakan **WebSockets**.
   - Dilengkapi penghitung karakter, kata, dan baris, tombol salin teks, serta opsi simpan sebagai `.txt`.

3. **Upload File Maksimal 5 GB (High Performance Streaming)**:
   - Mendukung berbagai tipe file dengan batas hingga **5 GB**.
   - Streaming multipart upload langsung ke disk dengan buffer 4 MB: tidak membebani RAM server dan tidak menggunakan file temporary ganda.
   - Drag & Drop interface dengan indikator progress bar, kecepatan transfer, dan estimasi waktu selesai (ETA).

4. **Langsung Download & Dukungan Resumable (Range Requests)**:
   - Saat link/tombol file dibuka atau diklik, file **langsung terdownload secara otomatis** ke perangkat (menggunakan header HTTP `Content-Disposition: attachment`).
   - Mendukung jeda & lanjut unduhan (pause & resume) dengan header HTTP `Accept-Ranges: bytes`.

5. **Docker Container Non-Root (Keamanan Maksimal)**:
   - Dijalankan di dalam container Docker ringan menggunakan image Alpine.
   - Menggunakan user non-root khusus (`USER appuser:appgroup` dengan UID 10001) untuk aspek keamanan terbaik.

---

## 🚀 Cara Menjalankan Aplikasi

### Opsi 1: Menjalankan dengan Docker Compose (Direkomendasikan)

1. Pastikan Docker dan Docker Compose sudah terpasang.
2. Jalankan perintah berikut di direktori proyek:
   ```bash
   docker-compose up -d --build
   ```
3. Buka browser dan akses:
   ```
   http://localhost:8080
   ```

---

### Opsi 2: Menjalankan Docker Container Secara Manual

1. Build image Docker:
   ```bash
   docker build -t notionly:latest .
   ```
2. Jalankan container:
   ```bash
   docker run -d -p 8080:8080 -v notionly_uploads:/app/uploads --name notionly-app notionly:latest
   ```

---

### Opsi 3: Menjalankan Secara Lokal (Tanpa Docker)

1. Pastikan **Go 1.22+** sudah terpasang.
2. Jalankan perintah:
   ```bash
   go mod tidy
   go run main.go
   ```
3. Akses via browser di `http://localhost:8080`.

---

## 📁 Struktur Direktori

```
notionly/
├── main.go               # Web server Go (WebSockets, REST API Upload/Download, HTTP Handlers)
├── go.mod                # Module dependencies (gorilla/websocket)
├── Dockerfile            # Multi-stage Docker build dengan non-root user
├── docker-compose.yml    # Orchestration Docker service & volume persistence
├── README.md             # Dokumentasi lengkap
├── uploads/              # Penyimpanan file per room
└── static/
    ├── index.html        # UI SPA (Single Page Application)
    ├── css/
    │   └── style.css     # Dark mode modern styling
    └── js/
        └── app.js        # Logic client-side (WebSocket sync & file upload 5 GB)
```

---

## 🛡️ Aspek Keamanan & Performansi
- **Non-Root Docker User**: Container berjalan di bawah pengguna yang tidak memiliki hak privileged root (`appuser`).
- **Path Traversal Protection**: Nama file dibersihkan menggunakan `filepath.Base` dan `filepath.Clean`.
- **Low Memory 5 GB Streaming**: Endpoint upload menggunakan streaming `MultipartReader` dengan buffer 4 MB langsung ke disk (tanpa memuat 5 GB ke RAM atau `/tmp`).
- **Resumable Downloads**: Mendukung HTTP Byte Ranges (`Accept-Ranges: bytes`) untuk unduhan file berukuran besar.
- **Enforced Body Limit**: Endpoint upload membatasi request body maksimum 5 GB menggunakan `http.MaxBytesReader` dan `io.LimitReader`.
- **Memory Efficient**: Sinkronisasi WebSockets secara murni menggunakan saluran Go concurrency (`channels` & `goroutines`).

---

## ⚙️ Catatan Konfigurasi Reverse Proxy (Nginx / Cloudflare)

Jika Anda menaruh aplikasi di belakang reverse proxy:
1. **Nginx**:
   Tambahkan konfigurasi berikut di blok server/location Nginx agar tidak membatasi file 5 GB dan timeout:
   ```nginx
   client_max_body_size 5120M;
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   proxy_request_buffering off; # Sangat disarankan: langsung streaming ke backend Go
   ```
2. **Cloudflare**:
   Paket gratis Cloudflare membatasi body upload HTTP ke 100 MB. Jika menggunakan Cloudflare, pastikan proxy (awan oranye) dinonaktifkan (DNS Only / Grey Cloud) untuk subdomain/domain upload, atau gunakan Enterprise/Direct IP agar upload 5 GB tidak diblokir Cloudflare.
