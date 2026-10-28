#!/usr/bin/env python3
# Stand-in for yt-dlp in the browser tests. YouTube cannot be reached from the
# test machine, so test links are answered with made-up details and downloads
# are handed to the real yt-dlp pointed at tests/media-server.mjs.
import json, os, sys, subprocess
args = sys.argv[1:]
with open('/tmp/ytd-test/argv.log', 'a') as f:
    f.write(json.dumps(args) + '\n')
SERVER = 'http://127.0.0.1:8099/'
VID = 'https://www.youtube.com/watch?v=TESTVID0001'
LIST = 'https://www.youtube.com/playlist?list=PLTEST'
WATCH_IN_LIST = 'https://www.youtube.com/watch?v=TESTVID0001&list=PLTEST'
BAD = 'https://www.youtube.com/watch?v=PRIVATE0001'

def fmt(fid, h, vc, tbr, ext='mp4'):
    return {'format_id': fid, 'height': h, 'vcodec': vc, 'acodec': 'none', 'tbr': tbr, 'ext': ext, 'protocol': 'https'}

video = {
    'id': 'TESTVID0001', 'title': 'Clinic tour test clip', 'uploader': 'Test Channel', 'duration': 40,
    'thumbnail': SERVER + 'thumb.jpg', 'extractor_key': 'Youtube',
    'subtitles': {'en': [{'ext': 'vtt', 'name': 'English'}]},
    'automatic_captions': {'th-orig': [{'ext': 'vtt', 'name': 'Thai (Original)'}], 'th': [{'ext': 'vtt', 'name': 'Thai'}], 'fr': [{'ext': 'vtt', 'name': 'French'}]},
    'chapters': [{'start_time': 0, 'end_time': 20, 'title': 'Intro'}, {'start_time': 20, 'end_time': 40, 'title': 'Steps'}],
    'formats': [
        {'format_id': '140', 'vcodec': 'none', 'acodec': 'mp4a.40.2', 'ext': 'm4a', 'tbr': 129, 'filesize': 650000, 'protocol': 'https'},
        {'format_id': '251', 'vcodec': 'none', 'acodec': 'opus', 'ext': 'webm', 'tbr': 140, 'protocol': 'https'},
        fmt('137', 1080, 'avc1.640028', 4400), fmt('248', 1080, 'vp9', 2600, 'webm'),
        fmt('136', 720, 'avc1.4d401f', 2200), fmt('135', 480, 'avc1.4d401e', 1100),
        fmt('313', 2160, 'vp9', 17000, 'webm'), fmt('271', 1440, 'vp9', 9000, 'webm'),
        {'format_id': '18', 'height': 360, 'vcodec': 'avc1.42001E', 'acodec': 'mp4a.40.2', 'tbr': 500, 'ext': 'webm', 'protocol': 'https', 'url': SERVER + 'clip.webm'},
    ],
}
big = dict(video, id='TESTVID0003', title='Long product shot test', subtitles={}, automatic_captions={}, chapters=[])
BIG = 'https://www.youtube.com/watch?v=TESTVID0003'
playlist = {'_type': 'playlist', 'extractor_key': 'YoutubeTab', 'id': 'PLTEST', 'title': 'Test playlist', 'uploader': 'Test Channel', 'playlist_count': 2,
            'entries': [{'id': 'TESTVID0001', 'ie_key': 'Youtube', 'url': VID, 'title': 'Clinic tour test clip', 'duration': 40}, {'id': 'TESTVID0002', 'ie_key': 'Youtube', 'url': 'https://www.youtube.com/watch?v=TESTVID0002', 'title': 'Second test clip', 'duration': 40}]}

STORIES = 'https://www.instagram.com/stories/testuser/'
stories = {'_type': 'playlist', 'extractor_key': 'InstagramStory', 'id': 'testuser', 'title': 'Story by testuser', 'webpage_url': STORIES,
           'entries': [{'id': 'st1', 'title': 'Video by testuser', 'duration': 40, 'webpage_url': STORIES}, {'id': 'st2', 'title': 'Video by testuser', 'duration': 40, 'webpage_url': STORIES}]}
STORY_ONE = 'https://www.instagram.com/stories/testuser/4017064269887659683/'
STORY_POST = 'https://www.instagram.com/p/De_equOkV6j/'
if '-J' in args:
    url = args[-1]
    if url == STORY_ONE:
        print('ERROR: [instagram:story] testuser: This content is unreachable. Use --cookies-from-browser or --cookies for the authentication.', file=sys.stderr); sys.exit(1)
    if url == STORY_POST and '--cookies' in args:
        print(json.dumps(dict(video, id='De_equOkV6j', title='Video by testuser', extractor_key='Instagram', subtitles={}, automatic_captions={}, chapters=[]))); sys.exit(0)
    if url == STORIES:
        print(json.dumps(stories)); sys.exit(0)
    if url == BAD:
        print('ERROR: [youtube] PRIVATE0001: Private video. Sign in if you\'ve been granted access to this video', file=sys.stderr); sys.exit(1)
    if url in (LIST, WATCH_IN_LIST):
        print(json.dumps(playlist)); sys.exit(0)
    if url == VID:
        print(json.dumps(video)); sys.exit(0)
    if url == BIG:
        print(json.dumps(big)); sys.exit(0)
if '-U' in args:
    print('Latest version: stable@2026.08.19 from yt-dlp/yt-dlp'); print('yt-dlp is up to date (stable@2026.08.19 from yt-dlp/yt-dlp)'); sys.exit(0)
args = [a for a in args if not a.startswith('deno:')]
if '--js-runtimes' in args: args.remove('--js-runtimes')
url = args[-1]
if url == VID: args[-1] = SERVER + 'clip.mp4'
if url == 'https://www.youtube.com/watch?v=TESTVID0002': args[-1] = SERVER + 'clip2.mp4'
if url == BIG: args[-1] = SERVER + 'big.mp4'
if url in (LIST, WATCH_IN_LIST, STORIES): args[-1] = SERVER + 'page.html'
if url == STORY_POST: args[-1] = SERVER + 'clip.mp4'
if url == BAD:
    print('ERROR: [youtube] PRIVATE0001: Private video', file=sys.stderr); sys.exit(1)
os.execvp('yt-dlp', ['yt-dlp'] + args)
