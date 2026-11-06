# Haven

**English** | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="docs/logo.png" alt="Haven icon" width="128">
</p>

<p align="center">
  <strong>A local photo and video manager for Windows and macOS</strong><br>
  No uploads, no imports. One smooth home for the photos scattered across your drives.
</p>

> Still digging through drive C:, drive D:, the Downloads folder and camera export folders for a photo?  
> Still opening hundreds of images in Explorer or Finder and watching it spin, freeze and hang?  
> **Haven is built for exactly those moments.**

Haven browses folders on your computer directly. It never asks you to import photos into a proprietary library and never uploads your images. It gathers photos from different drives and folders into one fast, clean interface where you can search, filter, rate, tag and view originals. The interface includes light and dark themes and frosted-glass panels rendered with CSS `backdrop-filter`.

---

## Why Haven?

- **One place for photos scattered everywhere**  
  Add multiple photo folders, expand the folder tree, or search subfolders you have not expanded yet. Your photos stay where they are; Haven helps you find them again.

- **Thousands of photos, still smooth**  
  The photo grid renders only the cards near the current viewport instead of drawing thousands of thumbnails at once. Scan results, thumbnails and RAW previews are cached, so reopening large folders is faster.

- **No imports, no uploads, no touching originals**  
  Original images stay in their folders. Haven only reads, previews and organizes them when you need it, which suits users who want to keep their folder structure.

- **Organize photos like a music library**  
  Ratings, tags, color labels, favorites, flags, Rejected status and smart albums all work on top of the folders you already have.

---

## Performance: built for large libraries

Haven does not load thousands of originals into memory at once:

- **Viewport virtualization**: the photo grid renders only the cards near the current viewport and loads more as you scroll.
- **Multi-level caching**: scan indexes, thumbnails and RAW previews are cached to avoid repeated scanning and decoding.
- **Originals on demand**: browsing the list does not load every full-size image; the original is read only when you view a photo.
- **Smart cross-folder search**: smart albums can combine filter conditions and search across folders inside the directories you have added.

So even when a single folder holds thousands of photos, browsing, filtering and switching folders stays responsive.

---

## Main features

- **Browse by folder**  
  Add multiple photo folders, expand the folder tree, or search subfolders that have not been expanded yet from the sidebar. The immediate subfolders of the current folder are listed above the photo grid, and the sidebar width can be dragged to resize.

- **Search and organize**  
  Search by file name; filter by format, rating, tags, color labels, favorites, flags and Rejected status; sort by name, date, size and more. Smart albums can combine these conditions and search across the added folders.

- **Batch actions**  
  In select mode you can set ratings, tags, color labels and statuses for many photos at once, and drag selected photos onto other folders in the sidebar.

- **Full-screen viewer**  
  Inspect photo details and zoom, pan and rotate the preview; change ratings, favorites, flags, Rejected status, tags and color labels directly from the bottom toolbar. Videos play inline when the codec is supported.

- **Local cache**  
  Scan results, thumbnails and RAW previews are cached; the photo grid renders only the cards near the current viewport.

- **Culling and editing workflow**  
  Cull photos right after a shoot and open them in Photoshop or another editor in one click, so culling and editing form a single flow.

  - **Smart stacks**  
    Burst and stacked shots are detected and collapsed automatically without taking extra space.

- **Light table**  
  Gather picks into a session-only darkroom: lay photos on a lit board, switch the lamp on and off, adjust brightness, drag/rotate/scale them, and hold Space to look closer with the magnifier (no need to switch it on first). Nothing is written to the library; closing Haven empties the board. The lamp state, brightness, colour temperature and the UI-sound switch are remembered on this machine; the pad has a metal bezel and rulers, ambient light follows the lamp, and double-clicking the brightness slider returns it to 100%.

  - **Add to the light table** from a photo's context menu or the bulk toolbar; open it from the button next to **Start Culling**.
  - **Arrange** with four layouts — justified rows, hero magazine (the selected photo becomes the hero), contact sheet (uniform 3:2 frames) and darkroom scatter; **Reset** returns to the poured-out default. `T` opens the layout menu.
  - **Leave or clear** with Esc, Delete (removes the selected photo from the board) or **Clear light table** (asks for confirmation first).

- **Interface language**  
  In **Settings → Language** you can switch the interface between **Follow System**, **简体中文** (Simplified Chinese), **English** and **日本語** (Japanese). Unsupported system languages fall back to English. The language is a device-local preference and is not synced through a shared NAS library.

---

## Download and install

### Windows 10/11 x64

Requires the Microsoft Edge WebView2 Runtime. Recent Windows versions usually include it; if it is missing, install it from the [Microsoft WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/).

1. Download `Haven-win64.zip` from [Releases](https://github.com/christo112233/Haven/releases/latest).
2. Extract the whole archive to a writable location, for example `D:\Apps\Haven`.
3. Run `Haven.exe`.

> Keep `updater.exe`, `version.txt` and `_internal/` next to the main program; do not move `Haven.exe` out on its own.  
> The release package already includes the required Python runtime.

### macOS 11+ (Apple Silicon)

The macOS build is currently **arm64 (Apple Silicon) only**, with macOS 11 as the minimum. The release is **ad-hoc signed and not notarized** (there is no Apple Developer ID), so the first launch needs manual approval:

1. Download `Haven-mac-arm64.dmg` from [Releases](https://github.com/christo112233/Haven/releases/latest).
2. Open the DMG and drag `Haven.app` onto the Applications shortcut in the installer window, then eject the disk image.
3. If the first launch reports that the developer cannot be verified, open **System Settings → Privacy & Security** and click **Open Anyway**; you can also right-click `Haven.app` → **Open**.
4. If macOS reports that the app is damaged, clear the quarantine flag once in Terminal:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Haven.app
   ```

> The same release also ships `Haven-mac-arm64.zip`; unzipping it and dragging the app into Applications works the same way. In-app updates use the zip package.  
> During an update Haven downloads, verifies and replaces the old version automatically (it relaunches when done and removes the old bundle and downloaded package on the next successful launch). Keep `Haven.app` in a writable location (normally Applications); running it from the Downloads folder or a read-only DMG refuses to update and asks you to move the app first. Because the build is ad-hoc signed and not notarized, macOS may ask again for access to your photo folders after an update.  
> Intel Macs are not supported (the RAW decoding dependency currently ships only an arm64 wheel).

---

## Quick start

1. Click the add button next to **Folders** in the sidebar and choose a directory; you can also drag a folder into the sidebar.
2. Click a folder to browse its photos; enable **Include Subfolders** to list images from nested folders as well. Click a photo to open the full-screen viewer.
3. Use the search field and filter controls at the top to narrow the results; set ratings and tags from the photo context menu or the full-screen toolbar. Click the select button to work on several photos at once.
4. Click **Start Culling** to create a culling session and collect the photos you plan to edit into one folder.

---

## Keyboard shortcuts

### macOS native menu

| Shortcut | Action |
| --- | --- |
| `⌘O` | Add folder |
| `⌘R` | Rescan the current folder |
| `⌘,` | Open Settings |
| `⌥⌘S` | Show or hide the sidebar |
| `⌃⌘F` | Toggle full screen |
| `⌘⇧C` | Copy the current file path |
| `⌘W` | Close the window |
| `⌘Q` | Quit Haven |

The native menu also provides the standard macOS Edit, Window and Help items (Undo/Redo, Cut/Copy/Paste, Select All, Minimize, Zoom, a link to the repository and the shortcut list), and the **View → Appearance** menu switches Follow System / Light / Dark. Switching the interface language rebuilds the native menu immediately.

### Full-screen viewer

| Key | Action |
| --- | --- |
| `←` / `→` or `A` / `D` | Previous / next photo |
| `Space` | Fit to window |
| `F` | Show or hide details |
| `Esc` | Close the viewer |

The mouse wheel zooms the photo and dragging pans it. Rotation in the viewer only changes the preview and never modifies the original file. Deleting asks for confirmation first, then moves the file to the system Recycle Bin / Trash.

---

## Formats and data

Haven recognizes common images (JPG, PNG, WebP, BMP, GIF, TIFF), HEIC/HEIF, common camera RAW formats (such as CR2, CR3, NEF, ARW and DNG), and videos such as MP4, MOV and MKV. Which RAW camera models work depends on LibRaw; whether a video plays inline depends on the WebView2 support for its container and codec, and unsupported files can still be opened with the system default application. Live Photo and Motion Photo pairs (a photo and a video with the same name) are partly supported.

Original images stay in their folders. Thumbnails, previews and the scan index live in the `.Haven/` directory inside each photo folder; Windows and macOS use the same cache, so switching platforms does not require regenerating it.

Read-only photo folders can still be browsed, but caches and the root identity for that folder cannot be persisted there. Removing a library root does not delete its photos, cache or annotations.

---

## Data and settings locations

| Location | Windows | macOS |
| --- | --- | --- |
| Settings `haven-settings.json` | Program folder | `~/Library/Application Support/Haven/haven-settings.json` |
| Library database `library/library.sqlite3` | Program folder `library/` (can be changed to a shared folder in Settings) | `~/Library/Application Support/Haven/library/` (can be changed to a shared folder in Settings) |
| Library marker and backups | `library.json` and `backups/` in the library folder | Same as on Windows |
| Photo folder cache | `<photo folder>/.Haven/` (shared by both platforms) | Same as on Windows |
| Update staging | `.updates/` in the program folder | `~/Library/Application Support/Haven/updates/` (removed after a successful update) |

The macOS `.app` bundle is never written at runtime; settings, the library and caches live in `~/Library/Application Support/Haven`. On Windows the layout is portable beside the executable, so keep the program folder in a writable location so settings, caches and updates can be saved.

Ratings, tags, favorites, flags, color labels and smart albums live in the **library database**:

- Windows: `library/library.sqlite3` in the program folder by default (the older `haven-metadata.sqlite3` is migrated automatically);
- macOS: `~/Library/Application Support/Haven/library/library.sqlite3`;
- The library database can be pointed at a shared folder such as a NAS directory in **Settings → Library location**. When Windows and macOS point at the same directory, ratings, tags and smart albums stay in sync; the `.Haven/library.json` file in each photo root records a stable library/root ID;
- The library directory keeps recent data snapshots under `backups/`. When the network drive is unavailable the photos can still be browsed, but annotations are temporarily unavailable.

Folder and appearance settings (including the interface language) live in `haven-settings.json`. The language setting is device-local and is not written to the shared library.

---

## Shared library (NAS)

Annotations no longer depend on absolute paths specific to one operating system. Each photo has a stable identity made of a `root_id` plus its relative POSIX path inside the root:

- Adding a root writes `library_id`, `root_id` and the folder name into `<root>/.Haven/library.json`, so `Z:\Photos` on Windows and `/Volumes/Photos` on macOS resolve to the same `root_id`.
- Paths are normalized to Unicode NFC and both sides are resolved first, which also covers mount-prefix differences such as `/var` → `/private/var` on macOS; the same NAS photos therefore get the same identity on both platforms.
- To share annotations, point **Settings → Library location** on both machines at the same NAS directory. The library database, `library.json` markers and `backups/` then travel with the shared folder.

When the shared location is unavailable, photos can still be browsed and `.Haven` caches are still used, but annotations are unavailable and the Settings dialog shows a warning.

---

## Updates and networking

Browsing and organizing photos works offline. Networking is used only to check for and download GitHub Releases updates and to open the release history when you ask for it.

- Both Windows and macOS support in-app automatic updates, and automatic update checks can be disabled in Settings. Both platforms share the same `update.json` published on GitHub Releases; the manifest contains a `platforms` map with `windows-x64` and `macos-arm64` entries.
- **Windows** uses a separate `updater.exe` plus `update.json`. The updater validates the HTTPS source, SHA256, file size and version, checks the archive layout, swaps the program files after Haven exits, and restores the previous files if the replacement fails.
- **macOS** downloads the release zip inside the app and verifies SHA256, the version, the Bundle ID and `codesign --verify`. A small shell helper then waits for Haven to exit, backs up and replaces `Haven.app`, and relaunches it; on failure it restores the backup. The old bundle and downloaded package are removed when the new version launches successfully for the first time.
- macOS refuses to update when running from App Translocation (for example straight from the Downloads folder or the read-only DMG) or without write permission, and asks you to move the app first. After an update, macOS may ask again for the photo-folder permissions (TCC); allow them when prompted.

Keeping the Windows build in a writable directory is recommended so that settings can be saved and updates can be installed.

---

## Development build

Source builds, tests and release steps are documented in the [development guide](docs/开发文档.md). In short:

- Windows 10/11 x64 with Python 3.14; macOS 11+ on Apple Silicon with Python 3.14.
- `requirements.txt` contains the runtime and build dependencies. The macOS installer image additionally needs `requirements-build.txt` (`dmgbuild`).
- Windows: run `scripts/build.ps1`. PyInstaller builds `dist/Haven/`, a separate one-file `updater.exe` is built, and the script generates `dist/Haven-win64.zip` and `update.json`.
- macOS: run `scripts/build_macos.sh`. PyInstaller with `BUNDLE` and the default ad-hoc code signing produces `dist/Haven.app`; the script verifies the arm64 slice and the code signature, `ditto` creates `dist/Haven-mac-arm64.zip` (used for in-app updates), and `dmgbuild` creates `dist/Haven-mac-arm64.dmg` (used for the first install).
- Run the backend tests with `python -m unittest discover -s tests -v`. Set `HAVEN_DATA_DIR` to override the user data directory for portable or sandboxed runs.

---

## Platform support

- **Windows 10/11 x64**: full support, using a frameless window with in-app controls and the Edge WebView2 runtime.
- **macOS 11+ (Apple Silicon)**: browsing, organizing, culling, culling export and the shared library are supported, with a native title bar (traffic lights) and a native menu bar.
- Both platforms share the same code and the same version number, and are built together for each release.
- Intel Macs are not supported (the RAW decoding dependency currently ships only an arm64 wheel).

---

## License

Haven is released under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the licenses of third-party libraries and icons.
