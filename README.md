# Video Downloader

My own downloader for YouTube and other video sites. It runs yt-dlp underneath and is built on the same setup as my Video Editor so it can move into the editor later. To open it, double-click `Start Video Downloader.bat`. To make an app I can pin to the taskbar, double-click `Build Video Downloader.bat`.

## Starting it

Node.js and Rust are needed, the same setup the Video Editor uses.

1. Double-click `Start Video Downloader.bat`.
2. The first start installs the app's parts into this folder and compiles the app, which takes several minutes. Later starts take seconds.
3. On its first run the app downloads yt-dlp (about 18 MB) and Deno (about 45 MB). It uses the FFmpeg the Video Editor already downloaded and fetches its own copy (about 190 MB) only when that is missing.

`Build Video Downloader.bat` makes `video-downloader.exe` in `src-tauri\target\release` and an installer in `src-tauri\target\release\bundle\nsis`.

## Installers for friends

GitHub builds the installers from the public repository shinigami1235-creator/Video-Downloader every time new code is pushed there. After about 20 minutes they are on the repository's Releases page under "Video Downloader (newest build)", and anyone can download them without a GitHub account. Send friends the link to that page: github.com/shinigami1235-creator/Video-Downloader/releases/latest

| File | For |
| --- | --- |
| `Video-Downloader-Windows-Setup.exe` | Windows |
| `Video-Downloader-Mac-Apple-Silicon.dmg` | Macs with an M chip (M1 and newer) |
| `Video-Downloader-Mac-Intel.dmg` | older Macs with an Intel chip |

On a Mac, open the DMG and drag Video Downloader into Applications. macOS blocks the first open since the app isn't signed with an Apple developer account ($99 a year). Open System Settings, go to Privacy & Security, scroll down and press Open Anyway beside Video Downloader. On its first run the Mac app downloads yt-dlp (about 35 MB), Deno (about 45 MB) and FFmpeg (about 60 MB).

## Using it

1. Paste a link into the box. The app reads it on paste, or press Look up. A link copied before switching to the app fills in by itself.
2. Pick Video, Small video, MP3, M4A or Transcript.
3. Pick the quality, or the size limit for a small video.
4. Pick Whole video, Choose parts or Chapters under Part.
5. Pick subtitles and tick anything under Also.
6. Press Download.

| Choice | What it does |
| --- | --- |
| Small video | Shrinks the video to fit under 25, 50, 100 or 200 MB for sending on LINE. A long video gets a smaller frame, and the card says which before you download. |
| Subtitles | Saves the captions as an SRT file next to the video, which the Video Editor imports. The list shows the uploader's subtitles and YouTube's automatic captions in the spoken language. |
| Save the thumbnail | Saves the cover picture as a JPG next to the video. |
| One file per chapter | Saves each chapter as its own file in a folder named after the video, as well as the whole video. It only shows for videos with chapters and only goes with Whole video. |
| Cut sponsor segments | Removes sponsor reads, self-promotion and subscribe reminders, using SponsorBlock's shared list. YouTube only. |
| Send to phone | Puts the finished file in Desktop Connector's Send to devices list. It only shows while Desktop Connector is open. Finished downloads also get a Send to phone button. |

## Transcripts

Transcript turns the speech in a video into a text file, using whisper.cpp on this computer with no account or upload. The app downloads only the sound, writes `Clinic tour.txt` with a new paragraph at each pause, then deletes the sound so only the text is left. Tick Keep the video to save the video next to it.

| Choice | What it does |
| --- | --- |
| Language | Detect it works for most videos. Picking the language helps with short clips and mixed speech. |
| Accuracy | Fast (148 MB), Good (190 MB) or Best (574 MB). The model downloads the first time it is used, and copies the Video Editor already has are used instead. |
| Translate to English | Writes the transcript in English whatever the spoken language, saved as `Clinic tour (English).txt`. |
| Subtitles (SRT) too | Also saves the transcript with times as an SRT file. |
| Keep the video | Saves the video as well. Without it, the downloaded sound is deleted once the text is written. |

Transcribe a file on this computer, under the link box, takes a video or audio file already saved here. The transcript is saved next to it and the file itself is never deleted or changed.

On Windows the speech program (a few MB) downloads the first time. Settings has Use the NVIDIA graphics card, which downloads the larger copy made for those cards and transcribes several times faster. The Mac app carries its own copy and uses the Mac's graphics chip already.

## Parts of a video

Choose parts opens a player with the video and one row of start and end times. Play the video, press Mark start and Mark end, and the times fill into the highlighted row. Times can also be typed as 1:05 or 1:02:30, and clicking into a time jumps the player there. Add another part adds a row that starts where the last one ended. The player uses YouTube's 360p copy and shows on most YouTube videos and on other sites that offer a plain video file. Where it doesn't show, type the times.

Chapters lists a video's chapters with tick boxes, and each ticked chapter downloads as a part named after the chapter, like `Clinic tour (Results).mp4`.

Each part saves as its own file named with its times, like `Clinic tour (1m05s to 2m30s, 1080p).mp4`. With two or more parts, Join the parts into one file puts them end to end in order, saved as `Clinic tour (3 parts).mp4`.

A watch link opened from a playlist reads both and opens on the one video, with a switch to the whole playlist.

Several links pasted or dragged in at once open as a list to tick. A playlist link opens the same list, and the ticked videos download into a folder named after the playlist. 
A page with videos embedded in it works the same way. Paste the link of the page the video sits on and the app lists every player it finds. Private Vimeo videos that only play on their own website download since the app tells Vimeo which page they came from.

Videos are saved as H.264 MP4 up to 1080p since that plays everywhere, the Video Editor included. 1440p and 4K only exist as VP9 or AV1 on YouTube, which Windows plays with the free VP9 and AV1 extensions from the Microsoft Store. A video's file name carries its height, like `Clinic tour 1080p.mp4`, so downloading it again at another quality makes a second file.

## The browser extension

The extension works in Chrome and Edge. Right-clicking a video gives Download with Video Downloader, and right-clicking anywhere else on a page gives Find videos on this page. Clicking the extension's icon lists every video on the page with a tick box. The app has to be open since the extension only passes links to it.

The extension also notes the video streams a page loads while a video plays. That catches videos a site starts by script, which the app can't find from the page link alone, so play the video for a few seconds before opening the list.

Links sent from the extension carry the browser's sign-in for that site, which Instagram, members-only and age-restricted videos need. Untick Use my sign-in for this site in the extension's list to send links without it. The app deletes the sign-in file once the download is done, and clears any left over each time it starts.

To install it:

1. Open Settings in the app, press How to install, then press Open the extension folder. That copies the extension into a folder called `Video Downloader extension` in Documents and opens it.
2. In Chrome, type `chrome://extensions` in the address bar and press Enter. In Edge, type `edge://extensions`.
3. Switch on Developer mode at the top right of that page. In Edge it is in the left column.
4. Press Load unpacked and pick the `Video Downloader extension` folder from step 1.
5. Click the jigsaw icon next to the address bar and press the pin beside Video Downloader.

After an app update, press Open the extension folder again to bring the copy up to date, then press the reload arrow on the extension's card in `chrome://extensions`. On a Mac the steps are the same in Chrome and Edge.

DRM-protected video from Netflix, paid streaming and most paid course platforms can't be downloaded, and the app says so.

## Sign-in for pasted links

Settings has Use my Firefox sign-in for pasted links. With it on, yt-dlp reads Firefox's cookies for any link pasted into the app. Chrome and Edge lock their sign-in data on Windows, so for those use the extension instead.

## When downloads stop working

YouTube changes how it serves videos every few weeks and yt-dlp is updated to keep up. The app updates yt-dlp once a day on start. When a link that used to work fails, open Settings and press Update yt-dlp.

## Where things are kept

The folders keep the app's first name, `ytdownloader`, so settings, the download list and the tools carried over when it was renamed.

| What | Where |
| --- | --- |
| Downloads | the Downloads folder, or the folder picked with Change |
| yt-dlp, Deno, FFmpeg and the speech program and models | `%LOCALAPPDATA%\com.cygnussolutions.ytdownloader\tools` |
| Sign-in files from the extension | `%LOCALAPPDATA%\com.cygnussolutions.ytdownloader\sign-in`, deleted after each download |
| Settings and the download list | `%APPDATA%\com.cygnussolutions.ytdownloader` |
| The same on a Mac | `~/Library/Caches/com.cygnussolutions.ytdownloader` for the tools and sign-in files, `~/Library/Application Support/com.cygnussolutions.ytdownloader` for settings |
| Build files | `node_modules` and `src-tauri\target` in this folder, about 2 GB together. Delete them any time since the next start rebuilds them. |

## For the Video Editor

The code that runs yt-dlp is in `src/engine`: `tools.js` installs the programs, `ytdlp.js` reads links and builds the download command, `shrink.js` makes small videos, `transcribe.js` runs whisper.cpp and `queue.js` runs the download list. They only use the `src/backend` files, which are the same as the editor's, plus an `env` option added to `proc_spawn` and a kill that also stops FFmpeg. The extension talks to `src-tauri/src/ext_server.rs` on 127.0.0.1 port 47821, which only answers this computer and only takes links from a browser extension.

## Tests

`tests/t01-flow.mjs` and `tests/t02-features.mjs` run the whole app in a browser against `tests/fake-ytdlp.py`, which answers test links with made-up details and hands downloads to the real yt-dlp pointed at test clips on `tests/media-server.mjs`. `tests/t03-extension.mjs` loads the extension in Chromium and checks its list against `tests/media/ext.html`. The test clips are made with FFmpeg's test pattern and are left out of this folder.
