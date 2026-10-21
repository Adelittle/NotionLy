// Global State
let currentRoomId = null;
let ws = null;
let currentFiles = [];
let uploadXHR = null;
let isRemoteUpdate = false;
let myClientId = Math.random().toString(36).substring(2, 9);
let activeTab = 'note';

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room') || window.location.hash.substring(1);

    if (roomParam) {
        document.getElementById('roomInput').value = roomParam;
        joinRoom(roomParam);
    }

    setupDragAndDrop();
    setupNoteEditorListeners();
    initMobileLayout();
});

// Mobile Layout & Tab Switching
function initMobileLayout() {
    switchTab(activeTab);
    window.addEventListener('resize', () => {
        if (window.innerWidth >= 768) {
            document.getElementById('notePanel').classList.remove('active');
            document.getElementById('filePanel').classList.remove('active');
        } else {
            switchTab(activeTab);
        }
    });
}

function switchTab(tab) {
    activeTab = tab;
    const notePanel = document.getElementById('notePanel');
    const filePanel = document.getElementById('filePanel');
    const tabNoteBtn = document.getElementById('tabNoteBtn');
    const tabFileBtn = document.getElementById('tabFileBtn');

    if (window.innerWidth < 768) {
        if (tab === 'note') {
            notePanel.classList.add('active');
            filePanel.classList.remove('active');
            tabNoteBtn.classList.add('active');
            tabFileBtn.classList.remove('active');
        } else {
            filePanel.classList.add('active');
            notePanel.classList.remove('active');
            tabFileBtn.classList.add('active');
            tabNoteBtn.classList.remove('active');
        }
    }
}

// Random Room Generator
function generateRandomRoom() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let randomStr = '';
    for (let i = 0; i < 6; i++) {
        randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    document.getElementById('roomInput').value = `room-${randomStr}`;
}

// Handle Form Join Submit
function handleJoinRoom(e) {
    e.preventDefault();
    const roomVal = document.getElementById('roomInput').value.trim();
    if (roomVal) {
        joinRoom(roomVal);
    }
}

// Join Room Logic
function joinRoom(roomID) {
    currentRoomId = roomID;
    
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + encodeURIComponent(roomID);
    window.history.pushState({ path: newUrl }, '', newUrl);

    document.getElementById('currentRoomDisplay').textContent = roomID;
    document.getElementById('roomModal').classList.add('hidden');
    document.getElementById('appContainer').classList.remove('hidden');

    initMobileLayout();
    connectWebSocket(roomID);
    loadFileList();
    showToast(`Tergabung ke: ${roomID}`, 'success');
}

// Leave Room
function leaveRoom() {
    if (ws) { ws.close(); ws = null; }
    currentRoomId = null;
    document.getElementById('appContainer').classList.add('hidden');
    document.getElementById('roomModal').classList.remove('hidden');
    
    const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
    window.history.pushState({ path: cleanUrl }, '', cleanUrl);
}

// Copy Link
function copyRoomLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Tautan disalin', 'success');
    }).catch(err => {
        showToast('Gagal menyalin', 'error');
    });
}

// WebSocket Connection
function connectWebSocket(roomID) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(roomID)}`;
    
    updateConnectionStatus('connecting', 'Menghubungkan');
    ws = new WebSocket(wsUrl);

    ws.onopen = () => updateConnectionStatus('connected', 'Tersambung');

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWSMessage(data);
        } catch (err) { console.error('WS parse error:', err); }
    };

    ws.onclose = () => {
        updateConnectionStatus('disconnected', 'Terputus');
        if (currentRoomId) {
            setTimeout(() => {
                if (currentRoomId && (!ws || ws.readyState === WebSocket.CLOSED)) {
                    connectWebSocket(currentRoomId);
                }
            }, 3000);
        }
    };
}

function updateConnectionStatus(state, text) {
    const dot = document.getElementById('statusDot');
    const label = document.getElementById('statusText');
    dot.className = `status-dot ${state}`;
    label.textContent = text;
}

// Handle WS Messages
function handleWSMessage(msg) {
    switch (msg.type) {
        case 'init':
            if (msg.note !== undefined) {
                isRemoteUpdate = true;
                document.getElementById('noteArea').value = msg.note;
                updateStats();
                isRemoteUpdate = false;
            }
            if (msg.clientCount !== undefined) {
                document.getElementById('userCount').textContent = msg.clientCount;
            }
            break;
        case 'note_update':
            if (msg.senderId !== myClientId) {
                isRemoteUpdate = true;
                const area = document.getElementById('noteArea');
                const start = area.selectionStart;
                const end = area.selectionEnd;
                
                area.value = msg.note || '';
                updateStats();
                area.setSelectionRange(start, end);
                isRemoteUpdate = false;
                triggerSyncBadge();
            }
            break;
        case 'user_presence':
            if (msg.clientCount !== undefined) {
                document.getElementById('userCount').textContent = msg.clientCount;
            }
            break;
        case 'file_notification':
            loadFileList();
            if (msg.filename) {
                showToast(`Berkas baru: ${msg.filename}`, 'success');
            }
            break;
    }
}

// Note Editor Sync
function setupNoteEditorListeners() {
    const noteArea = document.getElementById('noteArea');
    noteArea.addEventListener('input', () => {
        if (isRemoteUpdate) return;
        updateStats();
        triggerSyncBadge();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'note_update',
                note: noteArea.value,
                senderId: myClientId
            }));
        }
    });
}

function triggerSyncBadge() {
    const badge = document.getElementById('syncIndicator');
    badge.textContent = '...';
    badge.style.opacity = '0.5';
    setTimeout(() => {
        badge.textContent = 'Sinkron';
        badge.style.opacity = '1';
    }, 400);
}

function updateStats() {
    const text = document.getElementById('noteArea').value;
    const chars = text.length;
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    const lines = text === '' ? 1 : text.split('\n').length;

    document.getElementById('charCount').textContent = `${chars} ch`;
    document.getElementById('wordCount').textContent = `${words} wd`;
    document.getElementById('lineCount').textContent = `${lines} ln`;
}

function copyNoteContent() {
    const text = document.getElementById('noteArea').value;
    navigator.clipboard.writeText(text).then(() => showToast('Disalin', 'success'));
}

function downloadNoteTxt() {
    const text = document.getElementById('noteArea').value;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `note-${currentRoomId || 'share'}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function clearNoteContent() {
    if (confirm('Bersihkan catatan?')) {
        document.getElementById('noteArea').value = '';
        document.getElementById('noteArea').dispatchEvent(new Event('input'));
        showToast('Dibersihkan', 'success');
    }
}

// File Upload
function setupDragAndDrop() {
    const dropzone = document.getElementById('dropzone');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, preventDefaults, false);
    });
    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, () => dropzone.classList.add('dragover'), false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, () => dropzone.classList.remove('dragover'), false);
    });
    dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (dt.files.length > 0) uploadFile(dt.files[0]);
    });
}

function triggerFileInput() { document.getElementById('fileInput').click(); }
function handleFileSelect(e) {
    if (e.target.files.length > 0) uploadFile(e.target.files[0]);
}

function uploadFile(file) {
    const maxSizeBytes = 5 * 1024 * 1024 * 1024; // 5 GB limit
    if (file.size > maxSizeBytes) {
        showToast('Maksimal 5GB', 'error');
        return;
    }
    if (!currentRoomId) return;

    const formData = new FormData();
    formData.append('file', file);

    const progressCard = document.getElementById('uploadProgressContainer');
    const fileNameEl = document.getElementById('uploadingFileName');
    const percentageEl = document.getElementById('uploadPercentage');
    const barEl = document.getElementById('progressBar');
    const speedEl = document.getElementById('uploadSpeed');

    progressCard.classList.remove('hidden');
    fileNameEl.textContent = file.name;
    barEl.style.width = '0%';
    percentageEl.textContent = '0%';
    speedEl.textContent = 'Memulai unggahan...';

    let startTime = Date.now();

    uploadXHR = new XMLHttpRequest();
    uploadXHR.open('POST', `/api/upload?room=${encodeURIComponent(currentRoomId)}`, true);
    uploadXHR.timeout = 0; // Tidak ada timeout client-side untuk file besar 5GB

    uploadXHR.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const percent = Math.min(100, Math.round((e.loaded / e.total) * 100));
            barEl.style.width = `${percent}%`;
            percentageEl.textContent = `${percent}%`;

            const elapsedTime = (Date.now() - startTime) / 1000;
            if (elapsedTime > 0.5) {
                const speedBytesPerSec = e.loaded / elapsedTime;
                const remainingBytes = e.total - e.loaded;
                const etaSeconds = speedBytesPerSec > 0 ? Math.round(remainingBytes / speedBytesPerSec) : 0;
                const etaStr = formatDuration(etaSeconds);
                speedEl.textContent = `${formatBytes(e.loaded)} / ${formatBytes(e.total)} (${formatBytes(speedBytesPerSec)}/s • ETA: ${etaStr})`;
            } else {
                speedEl.textContent = `${formatBytes(e.loaded)} / ${formatBytes(e.total)}`;
            }
        }
    };

    uploadXHR.onload = () => {
        progressCard.classList.add('hidden');
        const status = uploadXHR.status;
        const responseText = uploadXHR.responseText;
        uploadXHR = null;

        if (status === 200) {
            showToast('Berhasil diunggah', 'success');
            loadFileList();
        } else {
            showToast(`Gagal: ${responseText || 'Error'}`, 'error');
        }
        document.getElementById('fileInput').value = '';
    };

    uploadXHR.onerror = () => {
        progressCard.classList.add('hidden');
        uploadXHR = null;
        showToast('Kesalahan jaringan saat mengunggah', 'error');
        document.getElementById('fileInput').value = '';
    };

    uploadXHR.ontimeout = () => {
        progressCard.classList.add('hidden');
        uploadXHR = null;
        showToast('Waktu upload habis (timeout)', 'error');
        document.getElementById('fileInput').value = '';
    };

    uploadXHR.send(formData);
}

function cancelUpload() {
    if (uploadXHR) {
        uploadXHR.abort();
        uploadXHR = null;
        document.getElementById('uploadProgressContainer').classList.add('hidden');
        showToast('Dibatalkan', 'error');
    }
}

function formatDuration(seconds) {
    if (seconds <= 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    return `${h}j ${m % 60}m`;
}

// Cegah tab tertutup tidak sengaja saat upload besar sedang berjalan
window.addEventListener('beforeunload', (e) => {
    if (uploadXHR) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// File List
function loadFileList() {
    if (!currentRoomId) return;
    fetch(`/api/files?room=${encodeURIComponent(currentRoomId)}`)
        .then(res => res.json())
        .then(files => {
            currentFiles = files;
            renderFileList(files);
        })
        .catch(err => console.error('Fetch error:', err));
}

function filterFiles() {
    const query = document.getElementById('fileSearchInput').value.toLowerCase();
    const filtered = currentFiles.filter(f => f.name.toLowerCase().includes(query));
    renderFileList(filtered);
}

function renderFileList(files) {
    const container = document.getElementById('fileList');

    if (!files || files.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" width="32" height="32" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="9" y1="14" x2="15" y2="14"></line></svg>
                <p>Belum ada berkas.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = files.map(file => {
        return `
            <div class="file-card">
                <div class="file-info">
                    <svg class="file-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                    <div class="file-meta-wrap">
                        <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                        <div class="file-meta">${file.formattedSize} • ${new Date(file.modTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                    </div>
                </div>
                <div class="file-actions">
                    <a href="${file.downloadUrl}" class="btn-action dl" title="Unduh" download="${escapeHtml(file.name)}">
                        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    </a>
                    <button class="btn-action del" onclick="deleteFile('${escapeHtml(file.storedName)}')" title="Hapus">
                        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function deleteFile(storedName) {
    if (confirm('Hapus berkas ini?')) {
        fetch(`/api/delete?room=${encodeURIComponent(currentRoomId)}&file=${encodeURIComponent(storedName)}`, {
            method: 'DELETE'
        })
        .then(res => res.json())
        .then(() => {
            showToast('Dihapus', 'success');
            loadFileList();
        })
        .catch(() => showToast('Gagal menghapus', 'error'));
    }
}

function formatBytes(b) {
    if (b === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), sizes.length - 1);
    return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// Toasts
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Add minimal icon based on type
    const iconStr = type === 'success' 
        ? `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" style="color:var(--status-sync)"><polyline points="20 6 9 17 4 12"></polyline></svg>`
        : `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" style="color:var(--status-error)"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
        
    toast.innerHTML = `${iconStr}<span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
