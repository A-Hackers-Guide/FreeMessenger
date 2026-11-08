# Optional Services: Media Center & Gaming

FreeMessenger can bundle optional services that integrate into the unified dashboard:

## Services

### 🎮 Sunshine (Game Streaming Server)
- Custom build compatible with Moonlight clients
- NVIDIA GPU acceleration support
- Stream games from your PC to any device
- Auto-hooks into Steam, Epic, GOG, etc.

### 📱 Moonlight (Game Streaming Client)  
- Connect to custom Sunshine or standard GameStream
- Play games on this PC from anywhere
- Works on Mac, Windows, Linux, mobile

### 🎬 Jellyfin (Media Server)
- Free, open-source alternative to Plex
- Stream movies, shows, music, photos
- Transcoding for old devices
- Custom setup: point to your media folders

### 🎥 Plex (Media Server)
- Centralized entertainment platform
- Smart recommendations
- Synced across all devices
- Custom setup: point to your media folders

### 🎧 Audiobookshelf
- Self-hosted audiobooks & podcasts
- Progress sync across devices
- Offline listening support
- Custom setup: audiobooks + podcasts folders

## Installation

### macOS Package (.pkg)
```bash
# Download installer
curl -O https://a-hackers-guide.github.io/FreeMessenger/FreeMessenger.pkg

# Double-click to install, answer setup questions about optional services
# App starts in background, never in dock
# Services start/stop with main app
```

### Windows Installer (.MSI)
```powershell
# Download
Invoke-WebRequest -Uri "https://a-hackers-guide.github.io/FreeMessenger/FreeMessenger.msi" -OutFile FreeMessenger.msi

# Run, select optional services during setup
# Service control from settings panel
```

### Linux AppImage
```bash
# Download
wget https://a-hackers-guide.github.io/FreeMessenger/FreeMessenger.AppImage
chmod +x FreeMessenger.AppImage

# Run, setup wizard shows optional services
./FreeMessenger.AppImage
```

## Unified Dashboard

After install, **Media & Gaming Center** tab in settings shows:

```
🎮 Media & Gaming Center

┌─────────────────────┐  ┌─────────────────────┐
│ 🎮 Sunshine         │  │ 🎬 Jellyfin        │
│ Game Streaming Srv  │  │ Media Server       │
│                     │  │                     │
│ [Stop] [Open]       │  │ [Start] [Settings] │
└─────────────────────┘  └─────────────────────┘

┌─────────────────────┐  ┌─────────────────────┐
│ 🎧 Audiobookshelf  │  │ 🎥 Plex            │
│ Audiobooks & Pod... │  │ Home Entertainment │
│                     │  │                     │
│ [Start] [Uninstall]│  │ [Start] [Settings] │
└─────────────────────┘  └─────────────────────┘

─────────────────────────────────────────────
✚ Install More Services
  □ Moonlight Client
```

Each service:
- **Status indicator:** 🟢 Running / 🔴 Stopped
- **Open button:** Direct link to service UI
- **Start/Stop:** Manage from dashboard
- **Settings:** Configure paths, bitrate, GPU, etc.
- **Uninstall:** Remove service

## How It Works

### Architecture

```
FreeMessenger (Main App)
├─ Remote Access (connect PC from anywhere)
├─ File Transfer (bidirectional)
├─ AI Connectors (use your API keys)
└─ Service Manager
   ├─ Sunshine (port 47989)
   ├─ Moonlight (client)
   ├─ Jellyfin (port 8096)
   ├─ Plex (port 32400)
   └─ Audiobookshelf (port 13378)
```

### Service Lifecycle

1. **Install:** Installer checks system, downloads binaries, asks setup questions
2. **First Run:** Quick setup GUI (never again after first time)
3. **Management:** Dashboard shows all services, one-click start/stop
4. **Auto-Start:** Services marked as "enabled" start with the app
5. **Remote Access:** Connect via FreeMessenger's remote computer access
6. **Uninstall:** Remove service completely or keep disabled

### Easy Setup (Non-Technical)

- **Sunshine:** "Use GPU for games? Yes/No" → Done
- **Jellyfin:** "Where are your movies?" → Pick folder → Done
- **Plex:** "Where are your movies?" → Pick folder → Done
- **Audiobookshelf:** "Audiobooks folder?" + "Podcasts folder?" → Done
- **Moonlight:** Just works

### Power User Features

- Per-service config files in `~/.freemessenger-services/`
- Service hotkeys (custom launcher)
- Bitrate/resolution presets for Sunshine
- Transcode profiles for Jellyfin
- Custom metadata for Plex
- Advanced scheduler for services

## Installer Builder

Builds macOS pkg, Windows MSI, Linux AppImage from single source.

```bash
# Build all installers
./build-installers.sh

# Or specific ones
./build-installers.sh --macos
./build-installers.sh --windows
./build-installers.sh --linux
```

Each installer:
- Bundles FreeMessenger app
- Includes optional service binaries
- Adds setup wizard for first run
- Registers in system (not in dock/taskbar)
- Auto-updates through FreeMessenger
