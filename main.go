package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	MaxFileSize   int64 = 5 * 1024 * 1024 * 1024        // 5 GB file limit
	MaxUploadSize int64 = MaxFileSize + (32 * 1024 * 1024) // 32 MB headroom for multipart headers/fields
	UploadDir           = "./uploads"
	Port                = "8080"
)

// WS Message structures
type Message struct {
	Type        string `json:"type"`        // "init", "note_update", "user_presence", "file_notification"
	Note        string `json:"note"`        // Note text
	SenderID    string `json:"senderId"`    // Unique ID of sender to avoid echo loop
	ClientCount int    `json:"clientCount"` // Active users in room
	Filename    string `json:"filename,omitempty"`
}

type Client struct {
	ID   string
	Room *Room
	Conn *websocket.Conn
	Send chan []byte
}

type Room struct {
	ID       string
	Note     string
	Clients  map[*Client]bool
	Register chan *Client
	Unregister chan *Client
	Broadcast  chan Message
	Mu       sync.RWMutex
}

type Hub struct {
	Rooms map[string]*Room
	Mu    sync.RWMutex
}

type FileInfo struct {
	Name       string    `json:"name"`
	StoredName string    `json:"storedName"`
	Size       int64     `json:"size"`
	Formatted  string    `json:"formattedSize"`
	ModTime    time.Time `json:"modTime"`
	DownloadURL string   `json:"downloadUrl"`
}

var hub = &Hub{
	Rooms: make(map[string]*Room),
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for dev/flexibility
	},
}

func getOrCreateRoom(roomID string) *Room {
	hub.Mu.Lock()
	defer hub.Mu.Unlock()

	roomID = strings.TrimSpace(roomID)
	if roomID == "" {
		roomID = "default"
	}

	room, exists := hub.Rooms[roomID]
	if !exists {
		room = &Room{
			ID:         roomID,
			Note:       "",
			Clients:    make(map[*Client]bool),
			Register:   make(chan *Client),
			Unregister: make(chan *Client),
			Broadcast:  make(chan Message),
		}
		hub.Rooms[roomID] = room
		go room.run()
	}
	return room
}

func (r *Room) run() {
	for {
		select {
		case client := <-r.Register:
			r.Mu.Lock()
			r.Clients[client] = true
			count := len(r.Clients)
			r.Mu.Unlock()

			// Send init state to newly connected client
			initMsg := Message{
				Type:        "init",
				Note:        r.Note,
				ClientCount: count,
			}
			bytes, _ := json.Marshal(initMsg)
			client.Send <- bytes

			// Broadcast presence to all in room
			r.broadcastPresence(count)

		case client := <-r.Unregister:
			r.Mu.Lock()
			if _, ok := r.Clients[client]; ok {
				delete(r.Clients, client)
				close(client.Send)
			}
			count := len(r.Clients)
			r.Mu.Unlock()

			r.broadcastPresence(count)

		case msg := <-r.Broadcast:
			if msg.Type == "note_update" {
				r.Mu.Lock()
				r.Note = msg.Note
				r.Mu.Unlock()
			}

			r.Mu.RLock()
			bytes, err := json.Marshal(msg)
			if err == nil {
				for client := range r.Clients {
					select {
					case client.Send <- bytes:
					default:
						close(client.Send)
						delete(r.Clients, client)
					}
				}
			}
			r.Mu.RUnlock()
		}
	}
}

func (r *Room) broadcastPresence(count int) {
	msg := Message{
		Type:        "user_presence",
		ClientCount: count,
	}
	bytes, err := json.Marshal(msg)
	if err != nil {
		return
	}

	r.Mu.RLock()
	defer r.Mu.RUnlock()
	for client := range r.Clients {
		select {
		case client.Send <- bytes:
		default:
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		c.Room.Unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(1024 * 1024) // 1MB max websocket frame for note updates

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			break
		}

		var msg Message
		if err := json.Unmarshal(message, &msg); err == nil {
			msg.SenderID = c.ID
			c.Room.Broadcast <- msg
		}
	}
}

func (c *Client) writePump() {
	defer func() {
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.Conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			if err := w.Close(); err != nil {
				return
			}
		}
	}
}

// WebSocket handler
func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		http.Error(w, "room-id is required", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}

	room := getOrCreateRoom(roomID)
	clientID := fmt.Sprintf("%d", time.Now().UnixNano())

	client := &Client{
		ID:   clientID,
		Room: room,
		Conn: conn,
		Send: make(chan []byte, 256),
	}

	client.Room.Register <- client

	go client.writePump()
	go client.readPump()
}

// File Upload Handler (Max 5 GB streaming without buffering entire file in memory or /tmp)
func handleFileUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	roomID := strings.TrimSpace(r.URL.Query().Get("room"))

	// Restrict total request body size to MaxUploadSize (5 GB + headroom)
	r.Body = http.MaxBytesReader(w, r.Body, MaxUploadSize)

	mr, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "Failed to parse multipart request: "+err.Error(), http.StatusBadRequest)
		return
	}

	var safeFilename, storedName, destPath string
	var written int64
	var fileUploaded bool

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				http.Error(w, "File exceeds maximum size limit of 5 GB", http.StatusBadRequest)
				return
			}
			http.Error(w, "Upload error: "+err.Error(), http.StatusBadRequest)
			return
		}

		// Handle room field if passed in multipart form
		if roomID == "" && part.FormName() == "room" {
			val, _ := io.ReadAll(io.LimitReader(part, 1024))
			roomID = strings.TrimSpace(string(val))
			part.Close()
			continue
		}

		if part.FormName() == "file" {
			if roomID == "" {
				part.Close()
				http.Error(w, "room-id parameter is required", http.StatusBadRequest)
				return
			}

			filename := part.FileName()
			if filename == "" {
				part.Close()
				continue
			}

			// Clean filename to prevent path traversal
			safeFilename = filepath.Base(filename)
			if safeFilename == "." || safeFilename == "/" || safeFilename == "" {
				part.Close()
				http.Error(w, "Invalid filename", http.StatusBadRequest)
				return
			}

			// Ensure upload directory exists for the room
			roomUploadDir := filepath.Join(UploadDir, filepath.Clean(roomID))
			if err := os.MkdirAll(roomUploadDir, 0755); err != nil {
				part.Close()
				http.Error(w, "Failed to create storage directory", http.StatusInternalServerError)
				return
			}

			// Create unique stored filename to avoid overwriting files with identical names
			timestamp := time.Now().UnixNano()
			storedName = fmt.Sprintf("%d_%s", timestamp, safeFilename)
			destPath = filepath.Join(roomUploadDir, storedName)

			destFile, err := os.Create(destPath)
			if err != nil {
				part.Close()
				http.Error(w, "Failed to create destination file: "+err.Error(), http.StatusInternalServerError)
				return
			}

			// Stream directly to destination file using a 4 MB buffer
			// LimitReader ensures the file part does not exceed MaxFileSize
			lr := io.LimitReader(part, MaxFileSize+1)
			buf := make([]byte, 4*1024*1024)
			written, err = io.CopyBuffer(destFile, lr, buf)

			if err != nil {
				destFile.Close()
				part.Close()
				os.Remove(destPath)
				var maxBytesErr *http.MaxBytesError
				if errors.As(err, &maxBytesErr) {
					http.Error(w, "File exceeds maximum size limit of 5 GB", http.StatusBadRequest)
					return
				}
				http.Error(w, "Failed to save file: "+err.Error(), http.StatusInternalServerError)
				return
			}

			if written > MaxFileSize {
				destFile.Close()
				part.Close()
				os.Remove(destPath)
				http.Error(w, "File exceeds maximum size limit of 5 GB", http.StatusBadRequest)
				return
			}

			_ = destFile.Sync()
			destFile.Close()
			part.Close()

			fileUploaded = true
			break
		}

		part.Close()
	}

	if !fileUploaded {
		http.Error(w, "No file provided in request", http.StatusBadRequest)
		return
	}

	// Broadcast file upload notification to room WS clients
	room := getOrCreateRoom(roomID)
	room.Broadcast <- Message{
		Type:     "file_notification",
		Filename: safeFilename,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File uploaded successfully",
		"file": FileInfo{
			Name:        safeFilename,
			StoredName:  storedName,
			Size:        written,
			Formatted:   formatBytes(written),
			ModTime:     time.Now(),
			DownloadURL: fmt.Sprintf("/api/download?room=%s&file=%s", roomID, storedName),
		},
	})
}

// File List Handler
func handleFileList(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		http.Error(w, "room-id parameter is required", http.StatusBadRequest)
		return
	}

	roomUploadDir := filepath.Join(UploadDir, filepath.Clean(roomID))
	entries, err := os.ReadDir(roomUploadDir)

	files := []FileInfo{}
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}

			storedName := entry.Name()
			// Extract original filename (after the timestamp prefix if present)
			originalName := storedName
			parts := strings.SplitN(storedName, "_", 2)
			if len(parts) == 2 {
				originalName = parts[1]
			}

			files = append(files, FileInfo{
				Name:        originalName,
				StoredName:  storedName,
				Size:        info.Size(),
				Formatted:   formatBytes(info.Size()),
				ModTime:     info.ModTime(),
				DownloadURL: fmt.Sprintf("/api/download?room=%s&file=%s", roomID, storedName),
			})
		}
	}

	// Sort files by mod time descending (newest first)
	sort.Slice(files, func(i, j int) bool {
		return files[i].ModTime.After(files[j].ModTime)
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(files)
}

// Direct File Download Handler
// Filenya jika dibuka langsung terdownload (Forces immediate download via Content-Disposition: attachment)
func handleFileDownload(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	storedFile := r.URL.Query().Get("file")

	if roomID == "" || storedFile == "" {
		http.Error(w, "room and file parameters are required", http.StatusBadRequest)
		return
	}

	// Security: prevent directory traversal
	cleanRoom := filepath.Clean(roomID)
	cleanFile := filepath.Base(storedFile)
	filePath := filepath.Join(UploadDir, cleanRoom, cleanFile)

	fileInfo, err := os.Stat(filePath)
	if err != nil || fileInfo.IsDir() {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Determine original user-friendly filename
	originalName := cleanFile
	parts := strings.SplitN(cleanFile, "_", 2)
	if len(parts) == 2 {
		originalName = parts[1]
	}

	// Sanitize filename quotes
	safeOriginalName := strings.ReplaceAll(originalName, `"`, `_`)

	// Set headers for direct download with Range support (resumable)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, safeOriginalName))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")

	http.ServeFile(w, r, filePath)
}

// Delete File Handler
func handleFileDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete && r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	roomID := r.URL.Query().Get("room")
	storedFile := r.URL.Query().Get("file")

	if roomID == "" || storedFile == "" {
		http.Error(w, "room and file parameters are required", http.StatusBadRequest)
		return
	}

	cleanRoom := filepath.Clean(roomID)
	cleanFile := filepath.Base(storedFile)
	filePath := filepath.Join(UploadDir, cleanRoom, cleanFile)

	if err := os.Remove(filePath); err != nil {
		http.Error(w, "Failed to delete file", http.StatusInternalServerError)
		return
	}

	// Notify websocket room
	room := getOrCreateRoom(roomID)
	room.Broadcast <- Message{
		Type: "file_notification",
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "File deleted",
	})
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

func main() {
	// Create upload root directory
	if err := os.MkdirAll(UploadDir, 0755); err != nil {
		log.Fatalf("Failed to create upload dir: %v", err)
	}

	// Serve Static Files
	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", fs)

	// API Endpoints
	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/api/upload", handleFileUpload)
	http.HandleFunc("/api/files", handleFileList)
	http.HandleFunc("/api/download", handleFileDownload)
	http.HandleFunc("/api/delete", handleFileDelete)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "80"
	}

	log.Printf("🚀 NotionLy server starting on port %s (Max upload: 5 GB)", port)
	log.Printf("🔗 Access publicly at http://47.250.161.65/")

	server := &http.Server{
		Addr:              ":" + port,
		ReadHeaderTimeout: 60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}
