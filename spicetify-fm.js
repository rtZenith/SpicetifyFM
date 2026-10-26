// SpicetifyFM v1.0.0 - In-App Last.fm Scrobbler for Spicetify
// Pure in-app Last.fm scrobbler inspired by Pano Scrobbler — zero third-party apps or external servers required.
// Features: Serverless Desktop Web Auth, UTF-8 MD5 Signing, Playbar Status Pill, Saved Per-Track Metadata Edits,
// Preset & Custom Regex Cleaners, Artist/Track Blocklist, Local Files Support, and Offline Queue with Auto-Retry.

(async function SpicetifyFM() {
    while (!Spicetify?.Player || !Spicetify?.Platform || !document.body) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // ==================== STORAGE KEYS & DEFAULT SETTINGS ====================
    const STORAGE_KEYS = {
        settings: 'spicetify_fm_settings_v1',
        edits: 'spicetify_fm_edits_v1',
        regexRules: 'spicetify_fm_regex_v1',
        blocklist: 'spicetify_fm_blocklist_v1',
        offlineQueue: 'spicetify_fm_queue_v1',
        sessionLog: 'spicetify_fm_session_log_v1',
        trackProgress: 'spicetify_fm_progress_v1',
    };

    const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
    const MAX_QUEUE_SIZE = 500;
    const MAX_BATCH_SCROBBLES = 50;
    const MAX_SESSION_LOG = 50;
    const MAX_SAVED_PROGRESS = 100;

    const DEFAULT_SETTINGS = {
        apiKey: '',
        apiSecret: '',
        sessionKey: '',
        username: '',
        userAvatar: '',
        userTotalPlaycount: 0,

        enabled: true,
        sendNowPlaying: true,
        scrobbleLocalFiles: true,
        scrobblePodcasts: false,
        showPlaybarPill: true,
        showNotifications: false,

        // Progress memory & seek bar sync
        saveTrackProgress: true,   // Save & restore progress when pausing, skipping, or restarting app
        syncSeekProgress: true,    // Update progress when seeking/passing minutes on the timeline

        // Pano Scrobbler timing rules
        thresholdPercent: 50,      // 25% to 95%
        maxThresholdSeconds: 240,  // 30s to 240s (4 minutes standard Last.fm cap)
        minDurationSeconds: 30,    // Minimum track length in seconds

        // Pano Scrobbler metadata cleaners
        firstArtistOnly: false,
        cleanRemastered: true,
        cleanDeluxe: true,
        cleanFeatFromTitle: false,
    };

    // ==================== STATE ====================
    let settings = loadJson(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
    settings = { ...DEFAULT_SETTINGS, ...settings };

    // Saved per-track edits keyed by normalized "artist::track"
    // Value: { rawArtist, rawTrack, artist, track, album, albumArtist, updatedAt }
    let savedEdits = loadJson(STORAGE_KEYS.edits, {});

    // Custom regex rules: Array of { id, name, field: 'track'|'artist'|'album'|'all', pattern, flags, replacement, enabled }
    let regexRules = loadJson(STORAGE_KEYS.regexRules, []);

    // Blocklist: { artists: string[], tracks: string[] ("artist::track") }
    let blocklist = loadJson(STORAGE_KEYS.blocklist, { artists: [], tracks: [] });
    if (!Array.isArray(blocklist.artists)) blocklist.artists = [];
    if (!Array.isArray(blocklist.tracks)) blocklist.tracks = [];

    // Offline scrobble queue: Array of { artist, track, album, albumArtist, duration, timestamp, queuedAt }
    let offlineQueue = loadJson(STORAGE_KEYS.offlineQueue, []);
    if (!Array.isArray(offlineQueue)) offlineQueue = [];

    // Recent session scrobbles
    let sessionLog = loadJson(STORAGE_KEYS.sessionLog, []);
    if (!Array.isArray(sessionLog)) sessionLog = [];

    // Saved per-track listening progress across pauses, skips, and restarts
    let savedProgressMap = loadJson(STORAGE_KEYS.trackProgress, {});
    if (!savedProgressMap || typeof savedProgressMap !== 'object') savedProgressMap = {};

    // Active playback tracking state
    let currentSession = null;
    let authPollingTimer = null;
    let authPollingState = { active: false, statusText: '', error: '' };
    let activeModalTab = 'now-playing';
    let isModalOpen = false;
    let isFlushingQueue = false;
    let recentLastFmTracks = null;
    let recentLastFmLoading = false;

    // ==================== PERSISTENCE HELPERS ====================
    function loadJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            return JSON.parse(raw);
        } catch (err) {
            console.warn('[SpicetifyFM] Failed to parse localStorage key:', key, err);
            return fallback;
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
        } catch (err) {
            console.error('[SpicetifyFM] Failed saving settings:', err);
        }
    }

    function saveEdits() {
        try {
            localStorage.setItem(STORAGE_KEYS.edits, JSON.stringify(savedEdits));
        } catch (err) {
            console.error('[SpicetifyFM] Failed saving edits:', err);
        }
    }

    function saveRegexRules() {
        try {
            localStorage.setItem(STORAGE_KEYS.regexRules, JSON.stringify(regexRules));
        } catch (err) {
            console.error('[SpicetifyFM] Failed saving regex rules:', err);
        }
    }

    function saveBlocklist() {
        try {
            localStorage.setItem(STORAGE_KEYS.blocklist, JSON.stringify(blocklist));
        } catch (err) {
            console.error('[SpicetifyFM] Failed saving blocklist:', err);
        }
    }

    function saveOfflineQueue() {
        try {
            if (offlineQueue.length > MAX_QUEUE_SIZE) {
                offlineQueue = offlineQueue.slice(offlineQueue.length - MAX_QUEUE_SIZE);
            }
            localStorage.setItem(STORAGE_KEYS.offlineQueue, JSON.stringify(offlineQueue));
        } catch (err) {
            console.error('[SpicetifyFM] Failed saving offline queue:', err);
        }
    }

    function saveSessionLog() {
        try {
            if (sessionLog.length > MAX_SESSION_LOG) {
                sessionLog = sessionLog.slice(0, MAX_SESSION_LOG);
            }
            localStorage.setItem(STORAGE_KEYS.sessionLog, JSON.stringify(sessionLog));
        } catch (err) {
            console.error('[SpicetifyFM] Failed saving session log:', err);
        }
    }

    function notify(message, isError = false, timeout = 3000) {
        if (Spicetify?.showNotification) {
            Spicetify.showNotification(`[SpicetifyFM] ${message}`, isError, timeout);
        }
    }

    // ==================== UTF-8 RFC 1321 MD5 & LAST.FM SIGNATURE ====================
    function md5Utf8(str) {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(str);
        const bitLen = bytes.length * 8;

        // Padding: append 0x80, then zeros until length % 64 === 56, then 64-bit little-endian length
        const padLen = ((56 - ((bytes.length + 1) % 64)) + 64) % 64;
        const totalLen = bytes.length + 1 + padLen + 8;
        const buf = new Uint8Array(totalLen);
        buf.set(bytes, 0);
        buf[bytes.length] = 0x80;

        const view = new DataView(buf.buffer);
        view.setUint32(totalLen - 8, bitLen >>> 0, true);
        view.setUint32(totalLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

        function rotl(x, n) {
            return (x << n) | (x >>> (32 - n));
        }

        const K = [
            0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
            0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
            0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
            0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
            0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
            0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
            0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
            0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
            0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
            0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
            0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
            0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
            0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
            0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
            0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
            0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
        ];

        const S = [
            7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
            5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
            4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
            6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
        ];

        let a0 = 0x67452301;
        let b0 = 0xefcdab89;
        let c0 = 0x98badcfe;
        let d0 = 0x10325476;

        const M = new Uint32Array(16);

        for (let offset = 0; offset < totalLen; offset += 64) {
            for (let j = 0; j < 16; j++) {
                M[j] = view.getUint32(offset + j * 4, true);
            }

            let A = a0;
            let B = b0;
            let C = c0;
            let D = d0;

            for (let i = 0; i < 64; i++) {
                let F, g;
                if (i < 16) {
                    F = (B & C) | (~B & D);
                    g = i;
                } else if (i < 32) {
                    F = (D & B) | (~D & C);
                    g = (5 * i + 1) % 16;
                } else if (i < 48) {
                    F = B ^ C ^ D;
                    g = (3 * i + 5) % 16;
                } else {
                    F = C ^ (B | ~D);
                    g = (7 * i) % 16;
                }

                const temp = D;
                D = C;
                C = B;
                const sum = (A + F + K[i] + M[g]) >>> 0;
                B = (B + rotl(sum, S[i])) >>> 0;
                A = temp;
            }

            a0 = (a0 + A) >>> 0;
            b0 = (b0 + B) >>> 0;
            c0 = (c0 + C) >>> 0;
            d0 = (d0 + D) >>> 0;
        }

        const outBuf = new ArrayBuffer(16);
        const outView = new DataView(outBuf);
        outView.setUint32(0, a0, true);
        outView.setUint32(4, b0, true);
        outView.setUint32(8, c0, true);
        outView.setUint32(12, d0, true);

        const outBytes = new Uint8Array(outBuf);
        let hex = '';
        for (let i = 0; i < 16; i++) {
            hex += outBytes[i].toString(16).padStart(2, '0');
        }
        return hex;
    }

    function createApiSignature(params, apiSecret) {
        const keys = Object.keys(params)
            .filter(k => k !== 'format' && k !== 'callback')
            .sort();
        let raw = '';
        for (const k of keys) {
            const val = params[k];
            if (val !== undefined && val !== null) {
                raw += k + String(val);
            }
        }
        raw += String(apiSecret || '').trim();
        return md5Utf8(raw);
    }

    // ==================== LAST.FM API CLIENT ====================
    function isAuthenticated() {
        return Boolean(
            settings.apiKey?.trim() &&
            settings.apiSecret?.trim() &&
            settings.sessionKey?.trim()
        );
    }

    async function lastFmRequest(params, { signed = false, method = 'POST' } = {}) {
        const apiKey = (settings.apiKey || '').trim();
        const apiSecret = (settings.apiSecret || '').trim();
        if (!apiKey) {
            throw new Error('Last.fm API Key is missing. Configure it in SpicetifyFM Settings.');
        }

        const cleanParams = {};
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null && v !== '') {
                cleanParams[k] = String(v);
            }
        }
        cleanParams.api_key = apiKey;

        if (signed) {
            if (!apiSecret) {
                throw new Error('Last.fm Shared Secret is missing. Configure it in SpicetifyFM Settings.');
            }
            cleanParams.api_sig = createApiSignature(cleanParams, apiSecret);
        }

        cleanParams.format = 'json';

        const searchParams = new URLSearchParams();
        for (const [k, v] of Object.entries(cleanParams)) {
            searchParams.append(k, v);
        }

        let response;
        if (method === 'GET') {
            response = await fetch(`${LASTFM_API_URL}?${searchParams.toString()}`, {
                method: 'GET',
            });
        } else {
            response = await fetch(LASTFM_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                },
                body: searchParams.toString(),
            });
        }

        const data = await response.json().catch(() => null);
        if (!response.ok || (data && data.error)) {
            const err = new Error(data?.message || `Last.fm HTTP ${response.status}`);
            err.code = data?.error || response.status;
            err.data = data;
            throw err;
        }
        return data;
    }

    const LastFmApi = {
        async getToken() {
            const data = await lastFmRequest({ method: 'auth.getToken' }, { signed: true, method: 'GET' });
            if (!data?.token) throw new Error('Failed to obtain auth token from Last.fm');
            return data.token;
        },

        async getSession(token) {
            const data = await lastFmRequest(
                { method: 'auth.getSession', token },
                { signed: true, method: 'POST' }
            );
            if (!data?.session?.key) {
                throw new Error('Session not ready yet');
            }
            return data.session; // { name, key, subscriber }
        },

        async getMobileSession(username, password) {
            const data = await lastFmRequest(
                { method: 'auth.getMobileSession', username, password },
                { signed: true, method: 'POST' }
            );
            if (!data?.session?.key) {
                throw new Error('Failed to authenticate with username/password');
            }
            return data.session;
        },

        async getUserInfo(username) {
            const user = username || settings.username;
            if (!user) return null;
            const data = await lastFmRequest(
                { method: 'user.getInfo', user },
                { signed: false, method: 'GET' }
            );
            return data?.user || null;
        },

        async updateNowPlaying({ artist, track, album, albumArtist, duration }) {
            if (!isAuthenticated()) return null;
            const params = {
                method: 'track.updateNowPlaying',
                artist,
                track,
                sk: settings.sessionKey.trim(),
            };
            if (album) params.album = album;
            if (albumArtist && albumArtist !== artist) params.albumArtist = albumArtist;
            if (duration && duration > 0) params.duration = Math.round(duration);
            return lastFmRequest(params, { signed: true, method: 'POST' });
        },

        async scrobbleBatch(scrobbles) {
            if (!isAuthenticated() || !scrobbles.length) return null;
            const batch = scrobbles.slice(0, MAX_BATCH_SCROBBLES);
            const params = {
                method: 'track.scrobble',
                sk: settings.sessionKey.trim(),
            };
            batch.forEach((item, i) => {
                params[`artist[${i}]`] = item.artist;
                params[`track[${i}]`] = item.track;
                params[`timestamp[${i}]`] = Math.floor(item.timestamp);
                if (item.album) params[`album[${i}]`] = item.album;
                if (item.albumArtist && item.albumArtist !== item.artist) {
                    params[`albumArtist[${i}]`] = item.albumArtist;
                }
                if (item.duration && item.duration > 0) {
                    params[`duration[${i}]`] = Math.round(item.duration);
                }
            });
            return lastFmRequest(params, { signed: true, method: 'POST' });
        },

        async getTrackInfo({ artist, track }) {
            if (!settings.apiKey?.trim() || !artist || !track) return null;
            const params = {
                method: 'track.getInfo',
                artist,
                track,
                autocorrect: '0',
            };
            if (settings.username) {
                params.username = settings.username;
            }
            const data = await lastFmRequest(params, { signed: false, method: 'GET' });
            return data?.track || null;
        },

        async setTrackLove({ artist, track, loved }) {
            if (!isAuthenticated()) throw new Error('Connect your Last.fm account first.');
            return lastFmRequest(
                {
                    method: loved ? 'track.love' : 'track.unlove',
                    artist,
                    track,
                    sk: settings.sessionKey.trim(),
                },
                { signed: true, method: 'POST' }
            );
        },

        async getRecentTracks(limit = 15) {
            if (!settings.apiKey?.trim() || !settings.username?.trim()) return [];
            const data = await lastFmRequest(
                {
                    method: 'user.getRecentTracks',
                    user: settings.username.trim(),
                    limit: String(limit),
                    extended: '1',
                },
                { signed: false, method: 'GET' }
            );
            const list = data?.recenttracks?.track;
            if (!list) return [];
            return Array.isArray(list) ? list : [list];
        },
    };

    // ==================== PANO SCROBBLER METADATA PIPELINE ====================
    function normalizeEditKey(artist, track) {
        return `${String(artist || '').trim().toLowerCase()}::${String(track || '').trim().toLowerCase()}`;
    }

    function normalizeArtistKey(artist) {
        return String(artist || '').trim().toLowerCase();
    }

    function isTrackOrArtistBlocked(artist, track) {
        const artistNorm = normalizeArtistKey(artist);
        const trackNorm = normalizeEditKey(artist, track);
        if (blocklist.artists.some(a => normalizeArtistKey(a) === artistNorm)) {
            return { blocked: true, reason: `Artist "${artist}" is blocked` };
        }
        if (blocklist.tracks.some(t => t.toLowerCase() === trackNorm)) {
            return { blocked: true, reason: `Track "${track}" is blocked` };
        }
        return { blocked: false, reason: '' };
    }

    function applyPresetCleaners({ track, artist, album, albumArtist }) {
        let t = String(track || '').trim();
        let ar = String(artist || '').trim();
        let al = String(album || '').trim();
        let alAr = String(albumArtist || '').trim();

        // 1. Remastered cleaner (Pano style)
        if (settings.cleanRemastered) {
            const remasterPatterns = [
                /\s*-\s*(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?).*$/i,
                /\s*[\(\[]\s*(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?\s*[\)\]]/gi,
                /\s*-\s*remastered$/i,
            ];
            for (const rx of remasterPatterns) {
                t = t.replace(rx, '');
                al = al.replace(rx, '');
            }
        }

        // 2. Deluxe / Edition cleaner
        if (settings.cleanDeluxe) {
            const deluxePatterns = [
                /\s*[\(\[]\s*(?:deluxe|super deluxe|expanded|special|anniversary|collector'?s|bonus track|digital|international|standard)\s*(?:edition|version|release|remaster)?\s*[\)\]]/gi,
                /\s*-\s*(?:deluxe|expanded|special)\s*(?:edition|version)$/i,
                /\s*-\s*(?:single|ep)$/i,
            ];
            for (const rx of deluxePatterns) {
                al = al.replace(rx, '');
                t = t.replace(rx, '');
            }
        }

        // 3. Featured artist cleaner from track title
        if (settings.cleanFeatFromTitle) {
            t = t
                .replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^\)\]]+[\)\]]/gi, '')
                .replace(/\s*-\s*(?:feat\.?|ft\.?|featuring)\s+.+$/i, '');
        }

        return {
            track: t.trim() || track,
            artist: ar.trim() || artist,
            album: al.trim(),
            albumArtist: alAr.trim(),
        };
    }

    function applyCustomRegexRules(meta) {
        let result = { ...meta };
        const appliedRules = [];

        for (const rule of regexRules) {
            if (!rule || !rule.enabled || !rule.pattern) continue;
            try {
                const rx = new RegExp(rule.pattern, rule.flags || 'gi');
                const replacement = rule.replacement ?? '';
                const fields =
                    rule.field === 'all'
                        ? ['track', 'artist', 'album', 'albumArtist']
                        : [rule.field || 'track'];

                let changed = false;
                for (const f of fields) {
                    if (typeof result[f] === 'string' && result[f]) {
                        const nextVal = result[f].replace(rx, replacement).trim();
                        if (nextVal && nextVal !== result[f]) {
                            result[f] = nextVal;
                            changed = true;
                        }
                    }
                }
                if (changed) {
                    appliedRules.push(rule.name || rule.pattern);
                }
            } catch (err) {
                console.warn('[SpicetifyFM] Invalid custom regex rule:', rule, err);
            }
        }

        return { ...result, appliedRules };
    }

    function extractRawSpotifyMetadata() {
        const data = Spicetify.Player?.data;
        const item = data?.item || data?.track;
        if (!item) return null;

        const uri = item.uri || '';
        const meta = item.metadata || {};

        const isLocal = uri.startsWith('spotify:local:') || meta.is_local === 'true';
        const isEpisode =
            item.type === 'episode' ||
            uri.startsWith('spotify:episode:') ||
            meta.media_type === 'video' ||
            Boolean(meta.show_name && !meta.artist_name);

        let rawTrack = item.name || meta.title || '';
        let rawArtist = '';
        let primaryArtist = '';

        if (Array.isArray(item.artists) && item.artists.length > 0) {
            primaryArtist = item.artists[0]?.name || '';
            rawArtist = item.artists.map(a => a.name).filter(Boolean).join(', ');
        }
        if (!rawArtist) {
            rawArtist = meta.artist_name || meta.show_name || '';
            primaryArtist = rawArtist.split(/,|;|\/|&/)[0]?.trim() || rawArtist;
        } else if (!primaryArtist) {
            primaryArtist = rawArtist;
        }

        let rawAlbum = item.album?.name || meta.album_title || '';
        let rawAlbumArtist = meta.album_artist_name || primaryArtist || rawArtist;

        // Decode local file URI fallback if metadata is missing:
        // Format: spotify:local:artist:album:track:duration_sec
        if (isLocal && (!rawTrack || !rawArtist)) {
            const parts = uri.split(':');
            if (parts.length >= 6) {
                const decArtist = decodeURIComponent(parts[2] || '').replace(/\+/g, ' ');
                const decAlbum = decodeURIComponent(parts[3] || '').replace(/\+/g, ' ');
                const decTrack = decodeURIComponent(parts[4] || '').replace(/\+/g, ' ');
                if (!rawArtist && decArtist) {
                    rawArtist = decArtist;
                    primaryArtist = decArtist;
                }
                if (!rawAlbum && decAlbum) rawAlbum = decAlbum;
                if (!rawTrack && decTrack) rawTrack = decTrack;
            }
        }

        let durationMs = Number(item.duration?.milliseconds || meta.duration || Spicetify.Player.getDuration() || 0);
        if (!durationMs && isLocal) {
            const parts = uri.split(':');
            const sec = Number(parts[5] || 0);
            if (sec > 0) durationMs = sec * 1000;
        }

        let imageUrl =
            meta.image_xlarge_url ||
            meta.image_large_url ||
            meta.image_url ||
            item.images?.[0]?.url ||
            item.album?.images?.[0]?.url ||
            '';
        if (imageUrl.startsWith('spotify:image:')) {
            imageUrl = `https://i.scdn.co/image/${imageUrl.replace('spotify:image:', '')}`;
        }

        if (!rawTrack) return null;
        if (!rawArtist) rawArtist = 'Unknown Artist';
        if (!primaryArtist) primaryArtist = rawArtist;

        return {
            uri,
            isLocal,
            isEpisode,
            rawTrack: rawTrack.trim(),
            rawArtist: rawArtist.trim(),
            primaryArtist: primaryArtist.trim(),
            rawAlbum: rawAlbum.trim(),
            rawAlbumArtist: rawAlbumArtist.trim(),
            durationMs,
            durationSec: Math.round(durationMs / 1000),
            imageUrl,
        };
    }

    function processMetadata(raw) {
        if (!raw) return null;

        const baseArtist = settings.firstArtistOnly ? raw.primaryArtist : raw.rawArtist;
        const editKey = normalizeEditKey(raw.rawArtist, raw.rawTrack);
        const primaryEditKey = normalizeEditKey(raw.primaryArtist, raw.rawTrack);
        const savedEdit = savedEdits[editKey] || savedEdits[primaryEditKey] || null;

        let track = raw.rawTrack;
        let artist = baseArtist;
        let album = raw.rawAlbum;
        let albumArtist = raw.rawAlbumArtist;
        let isEdited = false;
        let appliedRules = [];

        if (savedEdit) {
            track = savedEdit.track || track;
            artist = savedEdit.artist || artist;
            album = savedEdit.album !== undefined ? savedEdit.album : album;
            albumArtist = savedEdit.albumArtist !== undefined ? savedEdit.albumArtist : albumArtist;
            isEdited = true;
        } else {
            const presetCleaned = applyPresetCleaners({ track, artist, album, albumArtist });
            const regexCleaned = applyCustomRegexRules(presetCleaned);
            track = regexCleaned.track;
            artist = regexCleaned.artist;
            album = regexCleaned.album;
            albumArtist = regexCleaned.albumArtist;
            appliedRules = regexCleaned.appliedRules || [];
        }

        // Check blocklist against both raw and processed names
        const rawBlock = isTrackOrArtistBlocked(raw.rawArtist, raw.rawTrack);
        const cleanBlock = isTrackOrArtistBlocked(artist, track);
        const blocked = rawBlock.blocked || cleanBlock.blocked;
        const blockReason = rawBlock.reason || cleanBlock.reason;

        const wasCleaned =
            !isEdited &&
            (track !== raw.rawTrack ||
                artist !== raw.rawArtist ||
                album !== raw.rawAlbum);

        return {
            ...raw,
            editKey,
            track,
            artist,
            album,
            albumArtist,
            isEdited,
            wasCleaned,
            appliedRules,
            blocked,
            blockReason,
        };
    }

    // ==================== SCROBBLE ENGINE & OFFLINE QUEUE ====================
    function calculateTargetListenMs(durationMs) {
        const minMs = (settings.minDurationSeconds || 30) * 1000;
        if (durationMs > 0 && durationMs < minMs) {
            return Infinity; // Too short to scrobble automatically
        }
        const fallbackDurationMs = durationMs > 0 ? durationMs : 180000;
        const pctMs = fallbackDurationMs * ((settings.thresholdPercent || 50) / 100);
        const capMs = (settings.maxThresholdSeconds || 240) * 1000;
        return Math.max(10000, Math.min(pctMs, capMs));
    }

    async function flushOfflineQueue() {
        if (isFlushingQueue || !isAuthenticated() || offlineQueue.length === 0) return;
        isFlushingQueue = true;
        updateUI();

        try {
            while (offlineQueue.length > 0) {
                const batch = offlineQueue.slice(0, MAX_BATCH_SCROBBLES);
                await LastFmApi.scrobbleBatch(batch);
                offlineQueue.splice(0, batch.length);
                saveOfflineQueue();
            }
            if (settings.showNotifications) {
                notify('Flushed queued offline scrobbles to Last.fm!');
            }
        } catch (err) {
            console.warn('[SpicetifyFM] Queue flush paused/failed:', err.message || err);
            // If error is 9 (Invalid session key), stop retrying until user re-authenticates
            if (Number(err.code) === 9) {
                notify('Last.fm session expired. Please reconnect in SpicetifyFM Settings.', true);
            }
        } finally {
            isFlushingQueue = false;
            updateUI();
        }
    }

    async function fetchTrackDetailsForCurrentSession(session) {
        if (!session || !settings.apiKey?.trim()) return;
        try {
            const info = await LastFmApi.getTrackInfo({
                artist: session.artist,
                track: session.track,
            });
            if (!currentSession || currentSession.id !== session.id) return;
            if (info) {
                currentSession.userPlaycount = Number(info.userplaycount || 0);
                currentSession.userLoved = String(info.userloved) === '1';
                currentSession.lastFmUrl = info.url || '';
                updateUI();
            }
        } catch (err) {
            // Track may be new/unindexed on Last.fm — default to 0 playcount
            if (currentSession && currentSession.id === session.id) {
                currentSession.userPlaycount = currentSession.userPlaycount ?? 0;
                updateUI();
            }
        }
    }

    async function sendNowPlayingForCurrentSession(session) {
        if (
            !session ||
            !settings.enabled ||
            !settings.sendNowPlaying ||
            !isAuthenticated() ||
            session.blocked ||
            session.cancelled ||
            session.skippedByPolicy
        ) {
            return;
        }
        try {
            session.nowPlayingSent = true;
            await LastFmApi.updateNowPlaying({
                artist: session.artist,
                track: session.track,
                album: session.album,
                albumArtist: session.albumArtist,
                duration: session.durationSec,
            });
            updateUI();
        } catch (err) {
            console.warn('[SpicetifyFM] updateNowPlaying error:', err.message || err);
        }
    }

    async function triggerScrobble(session, { manual = false } = {}) {
        if (!session || session.scrobbled || session.scrobbling) return;
        if (!manual && (session.blocked || session.cancelled || session.skippedByPolicy)) return;

        session.scrobbling = true;
        updateUI();

        const scrobblePayload = {
            artist: session.artist,
            track: session.track,
            album: session.album,
            albumArtist: session.albumArtist,
            duration: session.durationSec,
            timestamp: session.startedAtUnix || Math.floor(Date.now() / 1000),
        };

        try {
            if (!isAuthenticated()) {
                throw new Error('Not connected to Last.fm');
            }
            await LastFmApi.scrobbleBatch([scrobblePayload]);
            session.scrobbled = true;
            session.scrobbling = false;
            session.queuedOffline = false;
            session.userPlaycount = (session.userPlaycount || 0) + 1;

            sessionLog.unshift({
                ...scrobblePayload,
                imageUrl: session.imageUrl,
                scrobbledAt: Math.floor(Date.now() / 1000),
                status: 'scrobbled',
                rawArtist: session.rawArtist,
                rawTrack: session.rawTrack,
            });
            saveSessionLog();

            if (settings.userTotalPlaycount > 0) {
                settings.userTotalPlaycount += 1;
                saveSettings();
            }

            if (settings.showNotifications || manual) {
                notify(`Scrobbled: ${session.artist} — ${session.track}`);
            }

            // Also attempt flushing any older offline queue items
            if (offlineQueue.length > 0) {
                flushOfflineQueue();
            }
        } catch (err) {
            console.warn('[SpicetifyFM] Scrobble failed, queueing offline:', err.message || err);
            session.scrobbling = false;
            session.queuedOffline = true;
            session.scrobbled = true; // Prevent duplicate attempts for the same play

            offlineQueue.push({
                ...scrobblePayload,
                queuedAt: Math.floor(Date.now() / 1000),
            });
            saveOfflineQueue();

            sessionLog.unshift({
                ...scrobblePayload,
                imageUrl: session.imageUrl,
                scrobbledAt: Math.floor(Date.now() / 1000),
                status: 'queued',
                rawArtist: session.rawArtist,
                rawTrack: session.rawTrack,
            });
            saveSessionLog();

            if (manual) {
                notify(`Saved to Offline Queue: ${session.track} (${err.message})`, true);
            }
        } finally {
            persistCurrentSessionProgress();
            updateUI();
        }
    }

    function getTrackProgressKey(meta) {
        if (!meta) return '';
        return meta.uri || normalizeEditKey(meta.rawArtist, meta.rawTrack);
    }

    function persistCurrentSessionProgress() {
        if (!currentSession || !settings.saveTrackProgress) return;
        const key = getTrackProgressKey(currentSession);
        if (!key) return;

        savedProgressMap[key] = {
            listenedMs: currentSession.listenedMs || 0,
            lastProgressMs: currentSession.lastProgressMs || 0,
            scrobbled: Boolean(currentSession.scrobbled),
            queuedOffline: Boolean(currentSession.queuedOffline),
            cancelled: Boolean(currentSession.cancelled),
            startedAtUnix: currentSession.startedAtUnix || Math.floor(Date.now() / 1000),
            updatedAt: Date.now(),
        };

        // Prune oldest entries if map exceeds MAX_SAVED_PROGRESS
        const keys = Object.keys(savedProgressMap);
        if (keys.length > MAX_SAVED_PROGRESS) {
            keys.sort((a, b) => (savedProgressMap[a]?.updatedAt || 0) - (savedProgressMap[b]?.updatedAt || 0));
            const toDelete = keys.slice(0, keys.length - MAX_SAVED_PROGRESS);
            for (const k of toDelete) {
                delete savedProgressMap[k];
            }
        }

        try {
            localStorage.setItem(STORAGE_KEYS.trackProgress, JSON.stringify(savedProgressMap));
        } catch (err) {
            console.warn('[SpicetifyFM] Failed saving track progress:', err);
        }
    }

    function startNewTrackSession({ forceFresh = false } = {}) {
        // Save outgoing track's progress before switching
        if (currentSession && !forceFresh) {
            persistCurrentSessionProgress();
        }

        const raw = extractRawSpotifyMetadata();
        if (!raw) {
            currentSession = null;
            updateUI();
            return;
        }

        const processed = processMetadata(raw);
        let skippedByPolicy = false;
        let policyReason = '';

        if (processed.isLocal && !settings.scrobbleLocalFiles) {
            skippedByPolicy = true;
            policyReason = 'Local Files disabled in settings';
        } else if (processed.isEpisode && !settings.scrobblePodcasts) {
            skippedByPolicy = true;
            policyReason = 'Podcasts/Episodes disabled in settings';
        } else if (
            processed.durationMs > 0 &&
            processed.durationMs < (settings.minDurationSeconds || 30) * 1000
        ) {
            skippedByPolicy = true;
            policyReason = `Shorter than minimum ${settings.minDurationSeconds}s`;
        }

        const targetListenMs = calculateTargetListenMs(processed.durationMs);
        const currentProgressMs = Spicetify.Player.getProgress() || 0;
        const progressKey = getTrackProgressKey(processed);

        let initialListenedMs = settings.syncSeekProgress ? currentProgressMs : 0;
        let initialScrobbled = false;
        let initialQueuedOffline = false;
        let initialCancelled = false;
        let initialStartedAt = Math.floor(Date.now() / 1000);

        if (!forceFresh && settings.saveTrackProgress && progressKey && savedProgressMap[progressKey]) {
            const saved = savedProgressMap[progressKey];
            const ageMs = Date.now() - (saved.updatedAt || 0);
            const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours

            if (ageMs < maxAgeMs) {
                if (!saved.scrobbled) {
                    // Resume saved un-scrobbled progress from before pause/skip/restart
                    initialListenedMs = Math.max(initialListenedMs, saved.listenedMs || 0);
                    initialCancelled = Boolean(saved.cancelled);
                    initialStartedAt = saved.startedAtUnix || initialStartedAt;
                } else if (currentProgressMs > 8000) {
                    // Still mid-song on a play that already scrobbled (e.g. reopened Spotify while paused)
                    initialListenedMs = Math.max(initialListenedMs, saved.listenedMs || 0);
                    initialScrobbled = true;
                    initialQueuedOffline = Boolean(saved.queuedOffline);
                    initialStartedAt = saved.startedAtUnix || initialStartedAt;
                } else {
                    // Song started fresh from 0:00 after previously scrobbling -> clear old state for new play
                    delete savedProgressMap[progressKey];
                }
            }
        }

        currentSession = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ...processed,
            startedAtUnix: initialStartedAt,
            listenedMs: initialListenedMs,
            targetListenMs,
            lastProgressMs: currentProgressMs,
            nowPlayingSent: false,
            scrobbled: initialScrobbled,
            scrobbling: false,
            queuedOffline: initialQueuedOffline,
            cancelled: initialCancelled,
            skippedByPolicy,
            policyReason,
            userPlaycount: null,
            userLoved: false,
            lastFmUrl: '',
        };

        persistCurrentSessionProgress();
        fetchTrackDetailsForCurrentSession(currentSession);
        updateUI();
    }

    function refreshCurrentSessionMetadata() {
        if (!currentSession) return;
        const raw = extractRawSpotifyMetadata();
        if (!raw) return;
        const processed = processMetadata(raw);

        const changed =
            processed.track !== currentSession.track ||
            processed.artist !== currentSession.artist ||
            processed.album !== currentSession.album ||
            processed.albumArtist !== currentSession.albumArtist;

        Object.assign(currentSession, processed);

        if (changed) {
            fetchTrackDetailsForCurrentSession(currentSession);
            if (!currentSession.scrobbled) {
                sendNowPlayingForCurrentSession(currentSession);
            }
        }
        updateUI();
    }

    // 1-second active playback ticker
    let tickCounter = 0;
    setInterval(() => {
        if (!currentSession) {
            const raw = extractRawSpotifyMetadata();
            if (raw) startNewTrackSession();
            return;
        }

        const raw = extractRawSpotifyMetadata();
        if (!raw) return;

        // Check if track changed without songchange event firing
        if (
            raw.uri !== currentSession.uri ||
            raw.rawTrack !== currentSession.rawTrack ||
            raw.rawArtist !== currentSession.rawArtist
        ) {
            startNewTrackSession();
            return;
        }

        // Update duration if Spotify loaded it slightly after songchange
        if (raw.durationMs > 0 && currentSession.durationMs !== raw.durationMs) {
            currentSession.durationMs = raw.durationMs;
            currentSession.durationSec = raw.durationSec;
            currentSession.targetListenMs = calculateTargetListenMs(raw.durationMs);
        }

        const currentProgressMs = Spicetify.Player.getProgress() || 0;

        // Detect Repeat-One replay: if already scrobbled (or listened > 25s) and player looped back near 0:00
        if (
            currentSession.scrobbled &&
            currentSession.lastProgressMs > 25000 &&
            currentProgressMs < 4000
        ) {
            startNewTrackSession({ forceFresh: true });
            return;
        }

        const seekDelta = Math.abs(currentProgressMs - currentSession.lastProgressMs);
        currentSession.lastProgressMs = currentProgressMs;

        // Sync progress if user seeked / passed minutes on the timeline
        if (settings.syncSeekProgress && currentProgressMs > currentSession.listenedMs) {
            currentSession.listenedMs = currentProgressMs;
            if (seekDelta > 2500) {
                persistCurrentSessionProgress();
            }
        }

        const isPlaying = Spicetify.Player.isPlaying();
        if (isPlaying) {
            currentSession.listenedMs = Math.max(
                currentSession.listenedMs + 1000,
                settings.syncSeekProgress ? currentProgressMs : 0
            );
            tickCounter++;
            if (tickCounter % 3 === 0) {
                persistCurrentSessionProgress();
            }
        }

        // Send Now Playing after 3 seconds of progress (avoids rapid skip spam)
        if (
            isPlaying &&
            settings.enabled &&
            !currentSession.nowPlayingSent &&
            currentSession.listenedMs >= 3000
        ) {
            sendNowPlayingForCurrentSession(currentSession);
        }

        // Check scrobble threshold (triggers whether reached via normal play or passing minutes on seek bar)
        if (
            settings.enabled &&
            !currentSession.scrobbled &&
            !currentSession.scrobbling &&
            !currentSession.blocked &&
            !currentSession.cancelled &&
            !currentSession.skippedByPolicy &&
            currentSession.listenedMs >= currentSession.targetListenMs
        ) {
            triggerScrobble(currentSession, { manual: false });
        }

        updatePlaybarPill();
        if (isModalOpen && activeModalTab === 'now-playing') {
            updateNowPlayingLiveProgress();
        }
    }, 1000);

    Spicetify.Player.addEventListener('songchange', () => {
        persistCurrentSessionProgress();
        setTimeout(() => startNewTrackSession(), 150);
    });

    Spicetify.Player.addEventListener('onplaypause', () => {
        persistCurrentSessionProgress();
        updatePlaybarPill();
    });

    window.addEventListener('beforeunload', () => {
        persistCurrentSessionProgress();
    });

    window.addEventListener('online', () => {
        if (offlineQueue.length > 0) {
            flushOfflineQueue();
        }
    });

    // ==================== DESKTOP WEB AUTH FLOW ====================
    function stopAuthPolling() {
        if (authPollingTimer) {
            clearInterval(authPollingTimer);
            authPollingTimer = null;
        }
        authPollingState.active = false;
    }

    async function startDesktopWebAuth() {
        const apiKey = (settings.apiKey || '').trim();
        const apiSecret = (settings.apiSecret || '').trim();

        if (!apiKey || !apiSecret) {
            notify('Please enter your Last.fm API Key and Shared Secret first.', true);
            return;
        }

        stopAuthPolling();
        authPollingState = {
            active: true,
            statusText: 'Requesting authorization token from Last.fm...',
            error: '',
        };
        renderModalContent();

        try {
            const token = await LastFmApi.getToken();
            const authUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;

            window.open(authUrl, '_blank');

            authPollingState.statusText =
                'Browser opened! Click "Yes, allow access" on Last.fm — waiting for authorization...';
            renderModalContent();

            let attempts = 0;
            const maxAttempts = 45; // ~2.25 minutes (every 3s)

            authPollingTimer = setInterval(async () => {
                attempts++;
                if (attempts > maxAttempts) {
                    stopAuthPolling();
                    authPollingState.error = 'Authorization timed out. Click "Connect with Last.fm" to try again.';
                    renderModalContent();
                    return;
                }

                try {
                    const session = await LastFmApi.getSession(token);
                    if (session?.key) {
                        stopAuthPolling();
                        settings.sessionKey = session.key;
                        settings.username = session.name || '';
                        saveSettings();

                        authPollingState.statusText = `Connected as ${settings.username}!`;
                        notify(`Connected to Last.fm as ${settings.username}!`);

                        // Fetch profile info (avatar & total scrobbles)
                        LastFmApi.getUserInfo(settings.username)
                            .then(userInfo => {
                                if (userInfo) {
                                    settings.userTotalPlaycount = Number(userInfo.playcount || 0);
                                    const imgs = userInfo.image;
                                    if (Array.isArray(imgs) && imgs.length > 0) {
                                        settings.userAvatar = imgs[imgs.length - 1]['#text'] || '';
                                    }
                                    saveSettings();
                                    updateUI();
                                }
                            })
                            .catch(() => {});

                        if (currentSession) {
                            fetchTrackDetailsForCurrentSession(currentSession);
                            sendNowPlayingForCurrentSession(currentSession);
                        }
                        if (offlineQueue.length > 0) {
                            flushOfflineQueue();
                        }
                        updateUI();
                    }
                } catch (pollErr) {
                    // Error code 14 = "This token has not been authorized" (normal while waiting for user click)
                    if (Number(pollErr.code) !== 14) {
                        console.debug('[SpicetifyFM] Auth poll status:', pollErr.message);
                    }
                }
            }, 3000);
        } catch (err) {
            stopAuthPolling();
            authPollingState.error = err.message || 'Failed to start Last.fm authentication.';
            notify(authPollingState.error, true);
            renderModalContent();
        }
    }

    // ==================== STYLES & SVG ICONS ====================
    const ICONS = {
        lastfm: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M10.584 17.21l-.88-2.392s-1.43 1.594-3.573 1.594c-1.897 0-3.244-1.649-3.244-4.288 0-3.382 1.704-4.591 3.381-4.591 2.42 0 3.189 1.567 3.849 3.574l.88 2.749c.88 2.666 2.529 4.81 7.285 4.81 3.409 0 5.718-1.044 5.718-3.793 0-2.227-1.265-3.381-3.63-3.931l-1.758-.385c-1.21-.275-1.567-.77-1.567-1.595 0-.934.742-1.484 1.952-1.484 1.32 0 2.034.495 2.144 1.677l2.749-.33c-.22-2.474-1.924-3.492-4.729-3.492-2.474 0-4.893.935-4.893 3.932 0 1.87.907 3.051 3.189 3.601l1.87.44c1.402.33 1.869.907 1.869 1.704 0 1.017-.99 1.43-2.86 1.43-2.776 0-3.93-1.457-4.59-3.464l-.907-2.75c-1.155-3.573-2.997-4.893-6.653-4.893C2.144 5.333 0 7.89 0 12.233c0 4.18 2.144 6.434 5.993 6.434 3.106 0 4.591-1.457 4.591-1.457z"/></svg>`,
        heartFilled: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.69 2A4.582 4.582 0 0 1 8 2.023 4.583 4.583 0 0 1 11.88.817h.002a4.618 4.618 0 0 1 3.782 3.65v.003a4.543 4.543 0 0 1-1.011 3.84L9.35 14.629a1.765 1.765 0 0 1-2.093.464 1.762 1.762 0 0 1-.605-.463L1.348 8.309A4.582 4.582 0 0 1 1.689 2z"/></svg>`,
        heartOutline: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M11.88.817A4.583 4.583 0 0 0 8 2.023 4.582 4.582 0 0 0 1.69 2a4.582 4.582 0 0 0-.342 6.309l5.304 6.32a1.765 1.765 0 0 0 2.698-.001l5.303-6.319a4.543 4.543 0 0 0 1.011-3.84v-.003A4.618 4.618 0 0 0 11.882.817zm2.313 6.532L8.89 13.668a.265.265 0 0 1-.405 0L3.182 7.349a3.082 3.082 0 0 1 .23-4.243 3.082 3.082 0 0 1 4.244.185l.344.369.344-.369a3.083 3.083 0 0 1 3.257-.956 3.118 3.118 0 0 1 2.553 2.464 3.043 3.043 0 0 1-.961 2.55z"/></svg>`,
        check: `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>`,
        edit: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086zM11.189 6.25 9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064l6.286-6.286z"/></svg>`,
        bolt: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M9.585.52a.5.5 0 0 1 .378.575l-1.15 5.405h4.187a.5.5 0 0 1 .39.812l-7 8.5a.5.5 0 0 1-.873-.412l1.15-5.405H2.48a.5.5 0 0 1-.39-.812l7-8.5a.5.5 0 0 1 .495-.163z"/></svg>`,
        block: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5a5.47 5.47 0 0 1 3.455 1.22L3.72 11.455A5.5 5.5 0 0 1 8 2.5zm0 11a5.47 5.47 0 0 1-3.455-1.22l7.735-7.735A5.5 5.5 0 0 1 8 13.5z"/></svg>`,
        trash: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6.5 1.75a.25.25 0 0 1 .25-.25h2.5a.25.25 0 0 1 .25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 1 0-1.492.15l.66 6.6A1.75 1.75 0 0 0 5.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 0 0-1.492-.149l-.66 6.6a.25.25 0 0 1-.249.225h-5.19a.25.25 0 0 1-.249-.225l-.66-6.6z"/></svg>`,
    };

    function injectStyles() {
        if (document.getElementById('spicetify-fm-styles')) return;
        const style = document.createElement('style');
        style.id = 'spicetify-fm-styles';
        style.textContent = `
            .spicetify-fm-pill-wrapper {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                margin: 0 6px;
            }
            .spicetify-fm-pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 28px;
                padding: 0 10px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.07);
                border: 1px solid rgba(255, 255, 255, 0.12);
                color: var(--spice-text, #fff);
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                user-select: none;
            }
            .spicetify-fm-pill:hover {
                background: rgba(217, 35, 35, 0.22);
                border-color: rgba(217, 35, 35, 0.55);
                transform: translateY(-1px);
            }
            .spicetify-fm-pill.state-scrobbled {
                background: rgba(30, 215, 96, 0.14);
                border-color: rgba(30, 215, 96, 0.45);
            }
            .spicetify-fm-pill.state-queued {
                background: rgba(245, 158, 11, 0.16);
                border-color: rgba(245, 158, 11, 0.45);
            }
            .spicetify-fm-pill.state-blocked {
                opacity: 0.6;
            }
            .spicetify-fm-pill-logo {
                display: inline-flex;
                align-items: center;
                color: #ef4444;
            }
            .spicetify-fm-pill.state-scrobbled .spicetify-fm-pill-logo {
                color: #1ed760;
            }
            .spicetify-fm-pill-count {
                font-variant-numeric: tabular-nums;
                font-size: 11px;
                padding: 1px 6px;
                border-radius: 999px;
                background: rgba(0, 0, 0, 0.35);
                color: rgba(255, 255, 255, 0.9);
            }
            .spicetify-fm-pill-love {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                border-radius: 50%;
                border: none;
                background: transparent;
                color: rgba(255, 255, 255, 0.65);
                cursor: pointer;
                transition: all 0.15s ease;
                padding: 0;
            }
            .spicetify-fm-pill-love:hover {
                color: #ef4444;
                transform: scale(1.12);
            }
            .spicetify-fm-pill-love.is-loved {
                color: #ef4444;
            }

            /* Modal Styles */
            .sfm-modal {
                font-family: var(--font-family, CircularSp, sans-serif);
                color: var(--spice-text, #ffffff);
                display: flex;
                flex-direction: column;
                gap: 14px;
                max-height: 72vh;
                overflow-y: auto;
                padding-right: 4px;
            }
            .sfm-tabs {
                display: flex;
                gap: 6px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                padding-bottom: 10px;
                flex-wrap: wrap;
            }
            .sfm-tab-btn {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(255, 255, 255, 0.08);
                color: rgba(255, 255, 255, 0.75);
                padding: 7px 14px;
                border-radius: 999px;
                font-size: 12.5px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s ease;
                display: inline-flex;
                align-items: center;
                gap: 6px;
            }
            .sfm-tab-btn:hover {
                background: rgba(255, 255, 255, 0.12);
                color: #fff;
            }
            .sfm-tab-btn.active {
                background: #d92323;
                border-color: #ef4444;
                color: #ffffff;
            }
            .sfm-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-size: 11px;
                font-weight: 700;
                padding: 2px 8px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.12);
            }
            .sfm-badge.green {
                background: rgba(30, 215, 96, 0.18);
                color: #1ed760;
                border: 1px solid rgba(30, 215, 96, 0.4);
            }
            .sfm-badge.red {
                background: rgba(217, 35, 35, 0.22);
                color: #ff6b6b;
                border: 1px solid rgba(217, 35, 35, 0.45);
            }
            .sfm-badge.amber {
                background: rgba(245, 158, 11, 0.2);
                color: #fbbf24;
                border: 1px solid rgba(245, 158, 11, 0.45);
            }
            .sfm-badge.blue {
                background: rgba(59, 130, 246, 0.2);
                color: #60a5fa;
                border: 1px solid rgba(59, 130, 246, 0.45);
            }
            .sfm-card {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.09);
                border-radius: 12px;
                padding: 14px;
            }
            .sfm-np-hero {
                display: flex;
                gap: 16px;
                align-items: center;
            }
            .sfm-np-cover {
                width: 84px;
                height: 84px;
                border-radius: 10px;
                object-fit: cover;
                background: rgba(255, 255, 255, 0.08);
                flex-shrink: 0;
                box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
            }
            .sfm-np-info {
                flex: 1;
                min-width: 0;
            }
            .sfm-np-title {
                font-size: 17px;
                font-weight: 700;
                margin: 0 0 4px 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .sfm-np-artist {
                font-size: 14px;
                color: rgba(255, 255, 255, 0.82);
                margin: 0 0 3px 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .sfm-np-album {
                font-size: 12px;
                color: rgba(255, 255, 255, 0.55);
                margin: 0 0 8px 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .sfm-progress-wrap {
                margin-top: 12px;
            }
            .sfm-progress-header {
                display: flex;
                justify-content: space-between;
                font-size: 12px;
                color: rgba(255, 255, 255, 0.75);
                margin-bottom: 6px;
                font-variant-numeric: tabular-nums;
            }
            .sfm-progress-bar {
                height: 7px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.1);
                overflow: hidden;
            }
            .sfm-progress-fill {
                height: 100%;
                border-radius: 999px;
                background: linear-gradient(90deg, #d92323, #ff5252);
                transition: width 0.35s ease;
            }
            .sfm-progress-fill.done {
                background: linear-gradient(90deg, #1ed760, #34d399);
            }
            .sfm-btn-row {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-top: 12px;
            }
            .sfm-btn {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 7px 13px;
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.14);
                background: rgba(255, 255, 255, 0.07);
                color: #fff;
                font-size: 12.5px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            .sfm-btn:hover:not(:disabled) {
                background: rgba(255, 255, 255, 0.15);
            }
            .sfm-btn:disabled {
                opacity: 0.45;
                cursor: not-allowed;
            }
            .sfm-btn.primary {
                background: #d92323;
                border-color: #ef4444;
            }
            .sfm-btn.primary:hover:not(:disabled) {
                background: #ef4444;
            }
            .sfm-btn.green {
                background: rgba(30, 215, 96, 0.18);
                border-color: rgba(30, 215, 96, 0.5);
                color: #1ed760;
            }
            .sfm-btn.danger {
                background: rgba(239, 68, 68, 0.15);
                border-color: rgba(239, 68, 68, 0.4);
                color: #fca5a5;
            }
            .sfm-grid-2 {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
            }
            .sfm-field {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .sfm-field label {
                font-size: 11.5px;
                font-weight: 600;
                color: rgba(255, 255, 255, 0.72);
            }
            .sfm-input, .sfm-select {
                background: rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 7px;
                padding: 7px 10px;
                color: #fff;
                font-size: 12.5px;
                outline: none;
            }
            .sfm-input:focus, .sfm-select:focus {
                border-color: #ef4444;
            }
            .sfm-toggle-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 0;
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            }
            .sfm-toggle-row:last-child {
                border-bottom: none;
            }
            .sfm-toggle-label {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .sfm-toggle-label strong {
                font-size: 13px;
            }
            .sfm-toggle-label span {
                font-size: 11.5px;
                color: rgba(255, 255, 255, 0.58);
            }
            .sfm-track-list {
                display: flex;
                flex-direction: column;
                gap: 6px;
                max-height: 300px;
                overflow-y: auto;
            }
            .sfm-track-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 8px 10px;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.06);
            }
            .sfm-track-row-left {
                display: flex;
                align-items: center;
                gap: 10px;
                min-width: 0;
                flex: 1;
            }
            .sfm-track-row-img {
                width: 36px;
                height: 36px;
                border-radius: 6px;
                object-fit: cover;
                background: rgba(255, 255, 255, 0.08);
                flex-shrink: 0;
            }
            .sfm-track-row-meta {
                min-width: 0;
                flex: 1;
            }
            .sfm-track-row-title {
                font-size: 13px;
                font-weight: 600;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .sfm-track-row-sub {
                font-size: 11.5px;
                color: rgba(255, 255, 255, 0.6);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .sfm-link {
                color: #ff6b6b;
                text-decoration: underline;
                cursor: pointer;
            }
        `;
        document.head.appendChild(style);
    }

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatTimeSec(sec) {
        const s = Math.max(0, Math.floor(sec || 0));
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return `${m}:${String(rem).padStart(2, '0')}`;
    }

    // ==================== PLAYBAR & TOPBAR PILL UI ====================
    let pillWrapperEl = null;
    let pillBtnEl = null;
    let pillLoveBtnEl = null;
    let topbarBtnEl = null;
    let pillObserver = null;

    function findPlaybarAnchor() {
        const playbarSelectors = [
            '[data-testid="lyrics-button"]',
            '[data-testid="control-button-queue"]',
            '[data-testid="control-button-npv"]',
            '[data-testid="pip-toggle-button"]',
            '[data-testid="volume-bar"]',
        ];

        const nowPlayingBar =
            document.querySelector('[data-testid="now-playing-bar"]') ||
            document.querySelector('footer');

        for (const sel of playbarSelectors) {
            const el = (nowPlayingBar || document).querySelector(sel);
            if (el) {
                let anchor = el;
                while (
                    anchor.parentElement &&
                    anchor.parentElement !== nowPlayingBar &&
                    anchor.parentElement.childElementCount === 1
                ) {
                    anchor = anchor.parentElement;
                }
                if (anchor.parentElement) {
                    return { container: anchor.parentElement, before: anchor };
                }
            }
        }

        const legacyRightBar =
            document.querySelector('.main-nowPlayingBar-right') ||
            document.querySelector('.main-nowPlayingBar-extraControls');
        if (legacyRightBar) {
            return { container: legacyRightBar, before: legacyRightBar.firstChild };
        }

        if (nowPlayingBar && nowPlayingBar.lastElementChild) {
            return {
                container: nowPlayingBar.lastElementChild,
                before: nowPlayingBar.lastElementChild.firstChild,
            };
        }

        return null;
    }

    function mountTopbarButton() {
        if (!topbarBtnEl) {
            topbarBtnEl = document.createElement('button');
            topbarBtnEl.id = 'spicetify-fm-topbar-btn';
            topbarBtnEl.className = 'spicetify-fm-pill';
            topbarBtnEl.style.marginInlineEnd = '8px';
            topbarBtnEl.title = 'Open SpicetifyFM (Last.fm Scrobbler) [Alt+L]';
            topbarBtnEl.innerHTML = `<span class="spicetify-fm-pill-logo">${ICONS.lastfm}</span><span>Last.fm</span>`;
            topbarBtnEl.addEventListener('click', () => openDashboardModal());
        }

        if (topbarBtnEl.isConnected) return;

        const userWidget = document.querySelector('#global-nav-bar [data-testid="user-widget-link"]');
        const navBar = document.getElementById('global-nav-bar');
        let anchor = userWidget;
        while (
            anchor?.parentElement &&
            anchor.parentElement !== navBar &&
            anchor.parentElement.childElementCount === 1
        ) {
            anchor = anchor.parentElement;
        }
        if (anchor?.parentElement) {
            anchor.parentElement.insertBefore(topbarBtnEl, anchor);
        } else if (navBar) {
            navBar.appendChild(topbarBtnEl);
        }
    }

    function ensurePlaybarPill() {
        injectStyles();
        mountTopbarButton();

        if (!settings.showPlaybarPill) {
            if (pillWrapperEl) {
                pillWrapperEl.remove();
            }
            return;
        }

        if (!pillWrapperEl) {
            pillWrapperEl = document.createElement('div');
            pillWrapperEl.id = 'spicetify-fm-pill-wrapper';
            pillWrapperEl.className = 'spicetify-fm-pill-wrapper';

            pillBtnEl = document.createElement('button');
            pillBtnEl.className = 'spicetify-fm-pill';
            pillBtnEl.title = 'Open SpicetifyFM (Last.fm Scrobbler) [Alt+L]';
            pillBtnEl.addEventListener('click', () => openDashboardModal());

            pillLoveBtnEl = document.createElement('button');
            pillLoveBtnEl.className = 'spicetify-fm-pill-love';
            pillLoveBtnEl.title = 'Love / Unlove Track on Last.fm';
            pillLoveBtnEl.addEventListener('click', async e => {
                e.stopPropagation();
                await toggleCurrentTrackLove();
            });

            pillWrapperEl.appendChild(pillBtnEl);
            pillWrapperEl.appendChild(pillLoveBtnEl);
        }

        if (!pillWrapperEl.isConnected) {
            const target = findPlaybarAnchor();
            if (target?.container) {
                if (target.before && target.before.parentElement === target.container) {
                    target.container.insertBefore(pillWrapperEl, target.before);
                } else {
                    target.container.prepend(pillWrapperEl);
                }
            }
        }

        if (!pillObserver && document.body) {
            pillObserver = new MutationObserver(() => {
                mountTopbarButton();
                if (settings.showPlaybarPill && pillWrapperEl && !pillWrapperEl.isConnected) {
                    const target = findPlaybarAnchor();
                    if (target?.container) {
                        if (target.before && target.before.parentElement === target.container) {
                            target.container.insertBefore(pillWrapperEl, target.before);
                        } else {
                            target.container.prepend(pillWrapperEl);
                        }
                    }
                }
            });
            pillObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    async function toggleCurrentTrackLove() {
        if (!currentSession) return;
        if (!isAuthenticated()) {
            openDashboardModal('settings');
            notify('Connect your Last.fm account first to love tracks.', true);
            return;
        }
        const nextLoved = !currentSession.userLoved;
        currentSession.userLoved = nextLoved;
        updateUI();

        try {
            await LastFmApi.setTrackLove({
                artist: currentSession.artist,
                track: currentSession.track,
                loved: nextLoved,
            });
            notify(
                `${nextLoved ? 'Loved ❤️' : 'Unloved'}: ${currentSession.artist} — ${currentSession.track}`
            );
        } catch (err) {
            currentSession.userLoved = !nextLoved;
            notify(`Failed to update Last.fm love status: ${err.message}`, true);
        } finally {
            updateUI();
        }
    }

    function syncPillButtonState(btn, stateClass, innerHtml) {
        if (!btn) return;
        btn.classList.remove('state-scrobbled', 'state-queued', 'state-blocked');
        if (stateClass) btn.classList.add(stateClass);
        btn.innerHTML = innerHtml;
    }

    function updatePlaybarPill() {
        ensurePlaybarPill();
        if (!pillBtnEl && !topbarBtnEl) return;

        if (!isAuthenticated()) {
            const html = `
                <span class="spicetify-fm-pill-logo">${ICONS.lastfm}</span>
                <span>Connect</span>
            `;
            syncPillButtonState(pillBtnEl, '', html);
            syncPillButtonState(topbarBtnEl, '', html);
            if (pillLoveBtnEl) pillLoveBtnEl.style.display = 'none';
            return;
        }

        if (!currentSession) {
            const html = `
                <span class="spicetify-fm-pill-logo">${ICONS.lastfm}</span>
                <span>Idle</span>
            `;
            syncPillButtonState(pillBtnEl, '', html);
            syncPillButtonState(topbarBtnEl, '', html);
            if (pillLoveBtnEl) pillLoveBtnEl.style.display = 'none';
            return;
        }

        if (pillLoveBtnEl) {
            pillLoveBtnEl.style.display = 'inline-flex';
            pillLoveBtnEl.classList.toggle('is-loved', Boolean(currentSession.userLoved));
            pillLoveBtnEl.innerHTML = currentSession.userLoved ? ICONS.heartFilled : ICONS.heartOutline;
        }

        const playcountBadge =
            currentSession.userPlaycount !== null
                ? `<span class="spicetify-fm-pill-count" title="Your Last.fm scrobbles for this song">${currentSession.userPlaycount}</span>`
                : '';

        if (currentSession.blocked || currentSession.cancelled || currentSession.skippedByPolicy) {
            const label = currentSession.blocked
                ? 'Blocked'
                : currentSession.cancelled
                ? 'Skipped'
                : 'Ignored';
            const html = `
                <span class="spicetify-fm-pill-logo">${ICONS.lastfm}</span>
                <span>${label}</span>
                ${playcountBadge}
            `;
            syncPillButtonState(pillBtnEl, 'state-blocked', html);
            syncPillButtonState(topbarBtnEl, 'state-blocked', html);
            return;
        }

        if (currentSession.queuedOffline) {
            const html = `
                <span class="spicetify-fm-pill-logo">${ICONS.lastfm}</span>
                <span>Queued (${offlineQueue.length})</span>
                ${playcountBadge}
            `;
            syncPillButtonState(pillBtnEl, 'state-queued', html);
            syncPillButtonState(topbarBtnEl, 'state-queued', html);
            return;
        }

        if (currentSession.scrobbled) {
            const html = `
                <span class="spicetify-fm-pill-logo">${ICONS.check}</span>
                <span>Scrobbled</span>
                ${playcountBadge}
            `;
            syncPillButtonState(pillBtnEl, 'state-scrobbled', html);
            syncPillButtonState(topbarBtnEl, 'state-scrobbled', html);
            return;
        }

        const pct =
            currentSession.targetListenMs && Number.isFinite(currentSession.targetListenMs)
                ? Math.min(100, Math.floor((currentSession.listenedMs / currentSession.targetListenMs) * 100))
                : 0;

        const html = `
            <span class="spicetify-fm-pill-logo">${ICONS.lastfm}</span>
            <span>${pct}%</span>
            ${playcountBadge}
        `;
        syncPillButtonState(pillBtnEl, '', html);
        syncPillButtonState(topbarBtnEl, '', html);
    }

    // ==================== DASHBOARD MODAL UI ====================
    function closeDashboardModal() {
        const existing = document.getElementById('spicetify-fm-modal-overlay');
        if (existing) existing.remove();
        isModalOpen = false;
    }

    function openDashboardModal(initialTab) {
        if (initialTab) activeModalTab = initialTab;
        closeDashboardModal();
        isModalOpen = true;

        const overlay = document.createElement('div');
        overlay.id = 'spicetify-fm-modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            z-index: 99999;
            background: rgba(0, 0, 0, 0.68);
            backdrop-filter: blur(6px);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            width: 720px;
            max-width: calc(100vw - 32px);
            max-height: 85vh;
            background: #18181b;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 16px;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65);
            padding: 20px 22px;
            display: flex;
            flex-direction: column;
            gap: 14px;
            color: #fff;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        `;
        header.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="color:#ef4444; display:inline-flex;">${ICONS.lastfm}</span>
                <strong style="font-size:18px; font-weight:700;">SpicetifyFM — Last.fm Scrobbler</strong>
            </div>
            <button id="sfm-close-modal-btn" style="background:rgba(255,255,255,0.08); border:none; color:#fff; width:30px; height:30px; border-radius:50%; cursor:pointer; font-size:16px; font-weight:700;">×</button>
        `;

        const container = document.createElement('div');
        container.id = 'spicetify-fm-modal-root';
        container.className = 'sfm-modal';

        dialog.appendChild(header);
        dialog.appendChild(container);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        header.querySelector('#sfm-close-modal-btn')?.addEventListener('click', closeDashboardModal);
        overlay.addEventListener('mousedown', e => {
            if (e.target === overlay) closeDashboardModal();
        });

        renderModalContent();
    }

    function updateNowPlayingLiveProgress() {
        const fillEl = document.getElementById('sfm-live-progress-fill');
        const labelEl = document.getElementById('sfm-live-progress-label');
        const statusEl = document.getElementById('sfm-live-status-text');
        if (!fillEl || !labelEl || !currentSession) return;

        const listenedSec = Math.floor(currentSession.listenedMs / 1000);
        const targetSec = Number.isFinite(currentSession.targetListenMs)
            ? Math.ceil(currentSession.targetListenMs / 1000)
            : 0;
        const pct = currentSession.scrobbled
            ? 100
            : targetSec > 0
            ? Math.min(100, Math.floor((currentSession.listenedMs / currentSession.targetListenMs) * 100))
            : 0;

        fillEl.style.width = `${pct}%`;
        fillEl.classList.toggle('done', Boolean(currentSession.scrobbled));

        if (currentSession.scrobbled) {
            labelEl.textContent = `${formatTimeSec(listenedSec)} listened • 100%`;
            if (statusEl) statusEl.textContent = currentSession.queuedOffline ? 'Queued Offline ⏳' : 'Scrobbled to Last.fm ✓';
        } else if (currentSession.blocked) {
            labelEl.textContent = currentSession.blockReason;
        } else if (currentSession.cancelled) {
            labelEl.textContent = 'Scrobble skipped for this play';
        } else {
            const remainingSec = Math.max(0, targetSec - listenedSec);
            labelEl.textContent = `${formatTimeSec(listenedSec)} / ${formatTimeSec(targetSec)} (${pct}% • ${remainingSec}s left)`;
        }
    }

    function renderModalContent() {
        const root = document.getElementById('spicetify-fm-modal-root');
        if (!root) {
            isModalOpen = false;
            return;
        }

        const queueBadge =
            offlineQueue.length > 0
                ? `<span class="sfm-badge amber">${offlineQueue.length}</span>`
                : '';

        const rulesCount =
            Object.keys(savedEdits).length +
            regexRules.length +
            blocklist.artists.length +
            blocklist.tracks.length;

        root.innerHTML = `
            <div class="sfm-tabs">
                <button class="sfm-tab-btn ${activeModalTab === 'now-playing' ? 'active' : ''}" data-tab="now-playing">
                    Now Playing
                </button>
                <button class="sfm-tab-btn ${activeModalTab === 'history' ? 'active' : ''}" data-tab="history">
                    History & Queue ${queueBadge}
                </button>
                <button class="sfm-tab-btn ${activeModalTab === 'rules' ? 'active' : ''}" data-tab="rules">
                    Pano Rules (Edits & Regex) ${rulesCount ? `<span class="sfm-badge">${rulesCount}</span>` : ''}
                </button>
                <button class="sfm-tab-btn ${activeModalTab === 'settings' ? 'active' : ''}" data-tab="settings">
                    Settings & Account ${!isAuthenticated() ? '<span class="sfm-badge red">Setup</span>' : ''}
                </button>
            </div>
            <div id="sfm-tab-body"></div>
        `;

        root.querySelectorAll('.sfm-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                activeModalTab = btn.getAttribute('data-tab');
                renderModalContent();
            });
        });

        const body = root.querySelector('#sfm-tab-body');
        if (activeModalTab === 'now-playing') {
            renderNowPlayingTab(body);
        } else if (activeModalTab === 'history') {
            renderHistoryTab(body);
        } else if (activeModalTab === 'rules') {
            renderRulesTab(body);
        } else if (activeModalTab === 'settings') {
            renderSettingsTab(body);
        }
    }

    function renderNowPlayingTab(container) {
        if (!isAuthenticated()) {
            container.innerHTML = `
                <div class="sfm-card" style="text-align:center; padding: 24px;">
                    <h3 style="margin:0 0 8px 0;">Connect Your Last.fm Account</h3>
                    <p style="color:rgba(255,255,255,0.7); font-size:13px; margin:0 0 16px 0;">
                        Authenticate directly in-app with Last.fm to start scrobbling your music, local files, and viewing your personal track playcounts.
                    </p>
                    <button class="sfm-btn primary" id="sfm-goto-settings-btn">
                        Configure Last.fm Account →
                    </button>
                </div>
            `;
            container.querySelector('#sfm-goto-settings-btn')?.addEventListener('click', () => {
                activeModalTab = 'settings';
                renderModalContent();
            });
            return;
        }

        if (!currentSession) {
            container.innerHTML = `
                <div class="sfm-card" style="text-align:center; padding: 24px;">
                    <p style="color:rgba(255,255,255,0.7); margin:0;">Play any song on Spotify to see live Last.fm scrobble status.</p>
                </div>
            `;
            return;
        }

        const s = currentSession;
        const listenedSec = Math.floor(s.listenedMs / 1000);
        const targetSec = Number.isFinite(s.targetListenMs) ? Math.ceil(s.targetListenMs / 1000) : 0;
        const pct = s.scrobbled
            ? 100
            : targetSec > 0
            ? Math.min(100, Math.floor((s.listenedMs / s.targetListenMs) * 100))
            : 0;

        let statusBadge = `<span class="sfm-badge red" id="sfm-live-status-text">Scrobbling...</span>`;
        if (s.blocked) {
            statusBadge = `<span class="sfm-badge red">Blocked 🚫</span>`;
        } else if (s.cancelled) {
            statusBadge = `<span class="sfm-badge amber">Skipped for this play ⏭️</span>`;
        } else if (s.skippedByPolicy) {
            statusBadge = `<span class="sfm-badge amber">${escapeHtml(s.policyReason)}</span>`;
        } else if (s.queuedOffline) {
            statusBadge = `<span class="sfm-badge amber" id="sfm-live-status-text">Queued Offline ⏳</span>`;
        } else if (s.scrobbled) {
            statusBadge = `<span class="sfm-badge green" id="sfm-live-status-text">Scrobbled to Last.fm ✓</span>`;
        }

        const badgesHtml = [
            statusBadge,
            s.userPlaycount !== null
                ? `<span class="sfm-badge">${s.userPlaycount} scrobbles</span>`
                : '',
            s.isLocal ? `<span class="sfm-badge blue">Local File</span>` : '',
            s.isEdited ? `<span class="sfm-badge blue">Pano Edited ✏️</span>` : '',
            s.wasCleaned ? `<span class="sfm-badge blue">Auto-Cleaned ✨</span>` : '',
        ]
            .filter(Boolean)
            .join(' ');

        const rawDiffNote =
            s.track !== s.rawTrack || s.artist !== s.rawArtist
                ? `<div style="font-size:11.5px; color:rgba(255,255,255,0.5); margin-top:4px;">
                       Original Spotify metadata: <strong>${escapeHtml(s.rawArtist)} — ${escapeHtml(s.rawTrack)}</strong>
                   </div>`
                : '';

        container.innerHTML = `
            <div class="sfm-card">
                <div class="sfm-np-hero">
                    ${
                        s.imageUrl
                            ? `<img class="sfm-np-cover" src="${escapeHtml(s.imageUrl)}" alt="Cover" />`
                            : `<div class="sfm-np-cover"></div>`
                    }
                    <div class="sfm-np-info">
                        <div class="sfm-np-title" title="${escapeHtml(s.track)}">${escapeHtml(s.track)}</div>
                        <div class="sfm-np-artist" title="${escapeHtml(s.artist)}">${escapeHtml(s.artist)}</div>
                        <div class="sfm-np-album" title="${escapeHtml(s.album)}">${escapeHtml(s.album || 'No Album')}</div>
                        <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
                            ${badgesHtml}
                        </div>
                        ${rawDiffNote}
                    </div>
                </div>

                <div class="sfm-progress-wrap">
                    <div class="sfm-progress-header">
                        <span>Scrobble Delay Threshold (${settings.thresholdPercent}% / max ${settings.maxThresholdSeconds}s)</span>
                        <span id="sfm-live-progress-label">${formatTimeSec(listenedSec)} / ${formatTimeSec(targetSec)} (${pct}%)</span>
                    </div>
                    <div class="sfm-progress-bar">
                        <div class="sfm-progress-fill ${s.scrobbled ? 'done' : ''}" id="sfm-live-progress-fill" style="width:${pct}%"></div>
                    </div>
                </div>

                <div class="sfm-btn-row">
                    <button class="sfm-btn ${s.userLoved ? 'primary' : ''}" id="sfm-np-love-btn">
                        ${s.userLoved ? ICONS.heartFilled : ICONS.heartOutline}
                        <span>${s.userLoved ? 'Loved on Last.fm' : 'Love Track'}</span>
                    </button>
                    <button class="sfm-btn green" id="sfm-np-scrobble-now-btn" ${s.scrobbled || s.scrobbling ? 'disabled' : ''}>
                        ${ICONS.bolt}
                        <span>${s.scrobbled ? 'Already Scrobbled' : 'Scrobble Now'}</span>
                    </button>
                    <button class="sfm-btn" id="sfm-np-cancel-btn" ${s.scrobbled ? 'disabled' : ''}>
                        <span>${s.cancelled ? 'Resume Scrobble' : 'Skip This Scrobble'}</span>
                    </button>
                    <button class="sfm-btn" id="sfm-np-edit-toggle-btn">
                        ${ICONS.edit}
                        <span>Edit Metadata (Pano Rule)</span>
                    </button>
                    <button class="sfm-btn danger" id="sfm-np-block-track-btn">
                        ${ICONS.block}
                        <span>${s.blocked ? 'Unblock' : 'Block Track/Artist'}</span>
                    </button>
                </div>

                <div id="sfm-np-edit-drawer" style="display:none; margin-top:14px; padding-top:14px; border-top:1px solid rgba(255,255,255,0.1);">
                    <div style="font-size:12.5px; font-weight:700; margin-bottom:8px;">
                        Save Custom Metadata Edit for "${escapeHtml(s.rawArtist)} — ${escapeHtml(s.rawTrack)}"
                    </div>
                    <div class="sfm-grid-2">
                        <div class="sfm-field">
                            <label>Track Title</label>
                            <input class="sfm-input" id="sfm-edit-track" value="${escapeHtml(s.track)}" />
                        </div>
                        <div class="sfm-field">
                            <label>Artist</label>
                            <input class="sfm-input" id="sfm-edit-artist" value="${escapeHtml(s.artist)}" />
                        </div>
                        <div class="sfm-field">
                            <label>Album</label>
                            <input class="sfm-input" id="sfm-edit-album" value="${escapeHtml(s.album)}" />
                        </div>
                        <div class="sfm-field">
                            <label>Album Artist</label>
                            <input class="sfm-input" id="sfm-edit-album-artist" value="${escapeHtml(s.albumArtist)}" />
                        </div>
                    </div>
                    <div class="sfm-btn-row" style="margin-top:10px;">
                        <button class="sfm-btn primary" id="sfm-save-edit-btn">Save Edit & Update Now Playing</button>
                        ${
                            s.isEdited
                                ? `<button class="sfm-btn danger" id="sfm-reset-edit-btn">Remove Saved Edit</button>`
                                : ''
                        }
                    </div>
                </div>
            </div>
        `;

        container.querySelector('#sfm-np-love-btn')?.addEventListener('click', () => {
            toggleCurrentTrackLove();
        });

        container.querySelector('#sfm-np-scrobble-now-btn')?.addEventListener('click', () => {
            triggerScrobble(currentSession, { manual: true });
        });

        container.querySelector('#sfm-np-cancel-btn')?.addEventListener('click', () => {
            currentSession.cancelled = !currentSession.cancelled;
            updateUI();
        });

        container.querySelector('#sfm-np-edit-toggle-btn')?.addEventListener('click', () => {
            const drawer = container.querySelector('#sfm-np-edit-drawer');
            if (drawer) {
                drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
            }
        });

        container.querySelector('#sfm-save-edit-btn')?.addEventListener('click', () => {
            const newTrack = container.querySelector('#sfm-edit-track')?.value.trim();
            const newArtist = container.querySelector('#sfm-edit-artist')?.value.trim();
            const newAlbum = container.querySelector('#sfm-edit-album')?.value.trim();
            const newAlbumArtist = container.querySelector('#sfm-edit-album-artist')?.value.trim();

            if (!newTrack || !newArtist) {
                notify('Track and Artist cannot be empty.', true);
                return;
            }

            const key = normalizeEditKey(s.rawArtist, s.rawTrack);
            savedEdits[key] = {
                rawArtist: s.rawArtist,
                rawTrack: s.rawTrack,
                track: newTrack,
                artist: newArtist,
                album: newAlbum,
                albumArtist: newAlbumArtist,
                updatedAt: Math.floor(Date.now() / 1000),
            };
            saveEdits();
            refreshCurrentSessionMetadata();
            notify(`Saved metadata edit for "${newArtist} — ${newTrack}"`);
        });

        container.querySelector('#sfm-reset-edit-btn')?.addEventListener('click', () => {
            const key = normalizeEditKey(s.rawArtist, s.rawTrack);
            delete savedEdits[key];
            delete savedEdits[normalizeEditKey(s.primaryArtist, s.rawTrack)];
            saveEdits();
            refreshCurrentSessionMetadata();
            notify('Removed saved track edit.');
        });

        container.querySelector('#sfm-np-block-track-btn')?.addEventListener('click', () => {
            const trackKey = normalizeEditKey(s.rawArtist, s.rawTrack);
            const artistKey = normalizeArtistKey(s.rawArtist);

            if (s.blocked) {
                blocklist.tracks = blocklist.tracks.filter(t => t.toLowerCase() !== trackKey);
                blocklist.artists = blocklist.artists.filter(a => normalizeArtistKey(a) !== artistKey);
                saveBlocklist();
                refreshCurrentSessionMetadata();
                notify('Unblocked track/artist.');
            } else {
                blocklist.tracks.push(`${s.rawArtist}::${s.rawTrack}`);
                saveBlocklist();
                refreshCurrentSessionMetadata();
                notify(`Blocked track "${s.rawArtist} — ${s.rawTrack}" from scrobbling.`);
            }
        });
    }

    function renderHistoryTab(container) {
        const queueHtml =
            offlineQueue.length > 0
                ? `
            <div class="sfm-card" style="border-color: rgba(245, 158, 11, 0.45); margin-bottom: 12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                    <div>
                        <strong style="color:#fbbf24;">Offline Scrobble Queue (${offlineQueue.length} pending)</strong>
                        <div style="font-size:11.5px; color:rgba(255,255,255,0.65);">
                            These tracks will be submitted in batches automatically when online.
                        </div>
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button class="sfm-btn primary" id="sfm-flush-queue-btn" ${isFlushingQueue ? 'disabled' : ''}>
                            ${isFlushingQueue ? 'Flushing...' : 'Flush Queue Now'}
                        </button>
                        <button class="sfm-btn danger" id="sfm-clear-queue-btn">
                            Clear Queue
                        </button>
                    </div>
                </div>
            </div>
        `
                : '';

        const sessionRowsHtml =
            sessionLog.length > 0
                ? sessionLog
                      .map(item => {
                          const timeAgo = item.scrobbledAt
                              ? new Date(item.scrobbledAt * 1000).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                })
                              : '';
                          return `
                    <div class="sfm-track-row">
                        <div class="sfm-track-row-left">
                            ${
                                item.imageUrl
                                    ? `<img class="sfm-track-row-img" src="${escapeHtml(item.imageUrl)}" />`
                                    : `<div class="sfm-track-row-img"></div>`
                            }
                            <div class="sfm-track-row-meta">
                                <div class="sfm-track-row-title">${escapeHtml(item.track)}</div>
                                <div class="sfm-track-row-sub">${escapeHtml(item.artist)}${
                              item.album ? ` • ${escapeHtml(item.album)}` : ''
                          }</div>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span class="sfm-badge ${item.status === 'queued' ? 'amber' : 'green'}">
                                ${item.status === 'queued' ? 'Queued' : 'Scrobbled'}
                            </span>
                            <span style="font-size:11px; color:rgba(255,255,255,0.5);">${timeAgo}</span>
                        </div>
                    </div>
                `;
                      })
                      .join('')
                : `<div style="font-size:12.5px; color:rgba(255,255,255,0.55); padding:10px 0;">No scrobbles in this session yet.</div>`;

        const remoteRowsHtml = recentLastFmLoading
            ? `<div style="font-size:12.5px; color:rgba(255,255,255,0.6); padding:10px 0;">Loading recent scrobbles from Last.fm...</div>`
            : Array.isArray(recentLastFmTracks) && recentLastFmTracks.length > 0
            ? recentLastFmTracks
                  .map(t => {
                      const title = t.name || '';
                      const artist = t.artist?.name || t.artist?.['#text'] || '';
                      const album = t.album?.['#text'] || '';
                      const nowPlaying = t['@attr']?.nowplaying === 'true';
                      const loved = String(t.loved) === '1';
                      const img =
                          Array.isArray(t.image) && t.image.length > 1
                              ? t.image[1]['#text']
                              : '';
                      return `
                    <div class="sfm-track-row">
                        <div class="sfm-track-row-left">
                            ${
                                img
                                    ? `<img class="sfm-track-row-img" src="${escapeHtml(img)}" />`
                                    : `<div class="sfm-track-row-img"></div>`
                            }
                            <div class="sfm-track-row-meta">
                                <div class="sfm-track-row-title">${escapeHtml(title)} ${loved ? '❤️' : ''}</div>
                                <div class="sfm-track-row-sub">${escapeHtml(artist)}${album ? ` • ${escapeHtml(album)}` : ''}</div>
                            </div>
                        </div>
                        <div>
                            ${
                                nowPlaying
                                    ? `<span class="sfm-badge red">Now Playing</span>`
                                    : `<span style="font-size:11px; color:rgba(255,255,255,0.55);">${escapeHtml(t.date?.['#text'] || '')}</span>`
                            }
                        </div>
                    </div>
                `;
                  })
                  .join('')
            : `<div style="font-size:12.5px; color:rgba(255,255,255,0.55); padding:10px 0;">Click "Refresh from Last.fm" to view your live profile scrobbles.</div>`;

        container.innerHTML = `
            ${queueHtml}
            <div class="sfm-card" style="margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <strong>In-App Session Log (${sessionLog.length})</strong>
                    ${
                        sessionLog.length > 0
                            ? `<button class="sfm-btn" id="sfm-clear-session-log-btn" style="padding:4px 10px; font-size:11.5px;">Clear Log</button>`
                            : ''
                    }
                </div>
                <div class="sfm-track-list">${sessionRowsHtml}</div>
            </div>

            <div class="sfm-card">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <strong>Last.fm Profile Recent Tracks ${settings.username ? `(@${escapeHtml(settings.username)})` : ''}</strong>
                    <button class="sfm-btn" id="sfm-refresh-remote-btn" style="padding:4px 10px; font-size:11.5px;">
                        Refresh from Last.fm
                    </button>
                </div>
                <div class="sfm-track-list">${remoteRowsHtml}</div>
            </div>
        `;

        container.querySelector('#sfm-flush-queue-btn')?.addEventListener('click', () => {
            flushOfflineQueue();
        });

        container.querySelector('#sfm-clear-queue-btn')?.addEventListener('click', () => {
            offlineQueue = [];
            saveOfflineQueue();
            updateUI();
        });

        container.querySelector('#sfm-clear-session-log-btn')?.addEventListener('click', () => {
            sessionLog = [];
            saveSessionLog();
            renderModalContent();
        });

        container.querySelector('#sfm-refresh-remote-btn')?.addEventListener('click', async () => {
            if (!settings.username || !settings.apiKey) {
                notify('Connect your Last.fm account first.', true);
                return;
            }
            recentLastFmLoading = true;
            renderModalContent();
            try {
                recentLastFmTracks = await LastFmApi.getRecentTracks(15);
            } catch (err) {
                notify(`Failed fetching recent tracks: ${err.message}`, true);
            } finally {
                recentLastFmLoading = false;
                renderModalContent();
            }
        });
    }

    function renderRulesTab(container) {
        const editsEntries = Object.entries(savedEdits);
        const editsHtml =
            editsEntries.length > 0
                ? editsEntries
                      .map(
                          ([key, item]) => `
                    <div class="sfm-track-row">
                        <div class="sfm-track-row-meta">
                            <div class="sfm-track-row-title">
                                ${escapeHtml(item.artist)} — ${escapeHtml(item.track)}
                                ${item.album ? `<span style="color:rgba(255,255,255,0.55); font-weight:400;">(${escapeHtml(item.album)})</span>` : ''}
                            </div>
                            <div class="sfm-track-row-sub">
                                Matches Spotify: ${escapeHtml(item.rawArtist)} — ${escapeHtml(item.rawTrack)}
                            </div>
                        </div>
                        <button class="sfm-btn danger sfm-del-edit-btn" data-key="${escapeHtml(key)}" style="padding:5px 9px;">
                            ${ICONS.trash}
                        </button>
                    </div>
                `
                      )
                      .join('')
                : `<div style="font-size:12px; color:rgba(255,255,255,0.55);">No saved per-track edits yet. Use "Edit Metadata" on the Now Playing tab to create one!</div>`;

        const regexHtml =
            regexRules.length > 0
                ? regexRules
                      .map(
                          (rule, idx) => `
                    <div class="sfm-track-row">
                        <div class="sfm-track-row-meta">
                            <div class="sfm-track-row-title">
                                <span class="sfm-badge blue">${escapeHtml(rule.field || 'track')}</span>
                                <code>/${escapeHtml(rule.pattern)}/${escapeHtml(rule.flags || 'gi')}</code>
                                → <code>"${escapeHtml(rule.replacement || '')}"</code>
                            </div>
                            <div class="sfm-track-row-sub">${escapeHtml(rule.name || 'Custom Regex Rule')}</div>
                        </div>
                        <button class="sfm-btn danger sfm-del-regex-btn" data-idx="${idx}" style="padding:5px 9px;">
                            ${ICONS.trash}
                        </button>
                    </div>
                `
                      )
                      .join('')
                : `<div style="font-size:12px; color:rgba(255,255,255,0.55);">No custom regex rules added yet.</div>`;

        const blockedItems = [
            ...blocklist.artists.map(a => ({ type: 'artist', value: a, label: `Artist: ${a}` })),
            ...blocklist.tracks.map(t => ({ type: 'track', value: t, label: `Track: ${t.replace('::', ' — ')}` })),
        ];

        const blocklistHtml =
            blockedItems.length > 0
                ? blockedItems
                      .map(
                          (item, idx) => `
                    <div class="sfm-track-row">
                        <div class="sfm-track-row-title">${escapeHtml(item.label)}</div>
                        <button class="sfm-btn danger sfm-del-block-btn" data-type="${item.type}" data-val="${escapeHtml(item.value)}" style="padding:5px 9px;">
                            Unblock
                        </button>
                    </div>
                `
                      )
                      .join('')
                : `<div style="font-size:12px; color:rgba(255,255,255,0.55);">No blocked artists or tracks.</div>`;

        container.innerHTML = `
            <div class="sfm-card" style="margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <strong>Saved Per-Track Metadata Edits (${editsEntries.length})</strong>
                </div>
                <div class="sfm-track-list">${editsHtml}</div>
            </div>

            <div class="sfm-card" style="margin-bottom:12px;">
                <strong style="display:block; margin-bottom:8px;">Pano Custom Regex Cleaners (${regexRules.length})</strong>
                <div class="sfm-grid-2" style="margin-bottom:8px;">
                    <div class="sfm-field">
                        <label>Rule Name</label>
                        <input class="sfm-input" id="sfm-rx-name" placeholder="e.g. Strip - Live suffix" />
                    </div>
                    <div class="sfm-field">
                        <label>Target Field</label>
                        <select class="sfm-select" id="sfm-rx-field">
                            <option value="track">Track Title</option>
                            <option value="artist">Artist</option>
                            <option value="album">Album</option>
                            <option value="all">All Fields</option>
                        </select>
                    </div>
                    <div class="sfm-field">
                        <label>Regex Pattern (JavaScript syntax)</label>
                        <input class="sfm-input" id="sfm-rx-pattern" placeholder="e.g. \\s*-\\s*Live.*$" />
                    </div>
                    <div class="sfm-field">
                        <label>Replacement Text (leave empty to strip)</label>
                        <input class="sfm-input" id="sfm-rx-replace" placeholder="" />
                    </div>
                </div>
                <button class="sfm-btn primary" id="sfm-add-regex-btn" style="margin-bottom:10px;">+ Add Regex Rule</button>
                <div class="sfm-track-list">${regexHtml}</div>
            </div>

            <div class="sfm-card">
                <strong style="display:block; margin-bottom:8px;">Blocklist — Artists & Tracks (${blockedItems.length})</strong>
                <div style="display:flex; gap:8px; margin-bottom:10px;">
                    <input class="sfm-input" id="sfm-block-artist-input" placeholder="Enter artist name to block (e.g. White Noise)" style="flex:1;" />
                    <button class="sfm-btn danger" id="sfm-add-block-artist-btn">Block Artist</button>
                </div>
                <div class="sfm-track-list">${blocklistHtml}</div>
            </div>
        `;

        container.querySelectorAll('.sfm-del-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-key');
                delete savedEdits[key];
                saveEdits();
                refreshCurrentSessionMetadata();
                renderModalContent();
            });
        });

        container.querySelector('#sfm-add-regex-btn')?.addEventListener('click', () => {
            const name = container.querySelector('#sfm-rx-name')?.value.trim() || 'Custom Rule';
            const field = container.querySelector('#sfm-rx-field')?.value || 'track';
            const pattern = container.querySelector('#sfm-rx-pattern')?.value || '';
            const replacement = container.querySelector('#sfm-rx-replace')?.value ?? '';

            if (!pattern) {
                notify('Enter a valid regular expression pattern.', true);
                return;
            }
            try {
                new RegExp(pattern, 'gi');
            } catch (err) {
                notify(`Invalid Regex: ${err.message}`, true);
                return;
            }

            regexRules.push({
                id: Date.now().toString(36),
                name,
                field,
                pattern,
                flags: 'gi',
                replacement,
                enabled: true,
            });
            saveRegexRules();
            refreshCurrentSessionMetadata();
            renderModalContent();
            notify(`Added regex rule "${name}"`);
        });

        container.querySelectorAll('.sfm-del-regex-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-idx'));
                regexRules.splice(idx, 1);
                saveRegexRules();
                refreshCurrentSessionMetadata();
                renderModalContent();
            });
        });

        container.querySelector('#sfm-add-block-artist-btn')?.addEventListener('click', () => {
            const artist = container.querySelector('#sfm-block-artist-input')?.value.trim();
            if (!artist) return;
            if (!blocklist.artists.some(a => normalizeArtistKey(a) === normalizeArtistKey(artist))) {
                blocklist.artists.push(artist);
                saveBlocklist();
                refreshCurrentSessionMetadata();
                renderModalContent();
                notify(`Blocked artist "${artist}"`);
            }
        });

        container.querySelectorAll('.sfm-del-block-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.getAttribute('data-type');
                const val = btn.getAttribute('data-val');
                if (type === 'artist') {
                    blocklist.artists = blocklist.artists.filter(a => a !== val);
                } else {
                    blocklist.tracks = blocklist.tracks.filter(t => t !== val);
                }
                saveBlocklist();
                refreshCurrentSessionMetadata();
                renderModalContent();
            });
        });
    }

    function renderSettingsTab(container) {
        const connected = isAuthenticated();

        const authStatusHtml = connected
            ? `
                <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 12px; border-radius:10px; background:rgba(30,215,96,0.12); border:1px solid rgba(30,215,96,0.35); margin-bottom:12px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        ${
                            settings.userAvatar
                                ? `<img src="${escapeHtml(settings.userAvatar)}" style="width:38px; height:38px; border-radius:50%; object-fit:cover;" />`
                                : `<span style="color:#1ed760;">${ICONS.check}</span>`
                        }
                        <div>
                            <div style="font-weight:700; font-size:14px; color:#1ed760;">
                                Connected as ${escapeHtml(settings.username || 'Last.fm User')}
                            </div>
                            <div style="font-size:11.5px; color:rgba(255,255,255,0.7);">
                                ${settings.userTotalPlaycount ? `${settings.userTotalPlaycount.toLocaleString()} total profile scrobbles • ` : ''}Direct In-App Session Active
                            </div>
                        </div>
                    </div>
                    <button class="sfm-btn danger" id="sfm-disconnect-btn">Disconnect</button>
                </div>
            `
            : '';

        const pollingStatusHtml =
            authPollingState.active || authPollingState.error
                ? `
                <div style="margin-top:10px; padding:10px; border-radius:8px; background:rgba(255,255,255,0.06); font-size:12.5px; color:${
                    authPollingState.error ? '#fca5a5' : '#fbbf24'
                };">
                    ${escapeHtml(authPollingState.error || authPollingState.statusText)}
                </div>
            `
                : '';

        container.innerHTML = `
            <div class="sfm-card" style="margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <strong>1. Last.fm API Credentials & In-App Authentication</strong>
                    <a class="sfm-link" id="sfm-open-api-create" style="font-size:12px;">
                        Get a free Last.fm API Key (takes 10s) ↗
                    </a>
                </div>
                ${authStatusHtml}
                <div class="sfm-grid-2">
                    <div class="sfm-field">
                        <label>Last.fm API Key</label>
                        <input class="sfm-input" id="sfm-input-api-key" placeholder="32-character hex API Key" value="${escapeHtml(settings.apiKey)}" />
                    </div>
                    <div class="sfm-field">
                        <label>Last.fm Shared Secret</label>
                        <input class="sfm-input" type="password" id="sfm-input-api-secret" placeholder="32-character hex Shared Secret" value="${escapeHtml(settings.apiSecret)}" />
                    </div>
                </div>
                <div class="sfm-btn-row">
                    <button class="sfm-btn primary" id="sfm-web-auth-btn">
                        ${ICONS.lastfm}
                        <span>${connected ? 'Re-authenticate with Last.fm' : 'Connect with Last.fm (Web Auth)'}</span>
                    </button>
                    <button class="sfm-btn" id="sfm-save-creds-btn">Save Keys</button>
                </div>
                ${pollingStatusHtml}
            </div>

            <div class="sfm-card" style="margin-bottom:12px;">
                <strong style="display:block; margin-bottom:8px;">2. Scrobble Timing & Delay (Pano Scrobbler Style)</strong>
                <div class="sfm-grid-2" style="margin-bottom:10px;">
                    <div class="sfm-field">
                        <label>Scrobble Percentage: <span id="sfm-lbl-pct">${settings.thresholdPercent}%</span> of track</label>
                        <input type="range" min="25" max="95" step="5" id="sfm-range-pct" value="${settings.thresholdPercent}" />
                    </div>
                    <div class="sfm-field">
                        <label>Maximum Delay Cap: <span id="sfm-lbl-cap">${settings.maxThresholdSeconds}s</span> (240s = 4m)</label>
                        <input type="range" min="30" max="240" step="10" id="sfm-range-cap" value="${settings.maxThresholdSeconds}" />
                    </div>
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Enable Scrobbling</strong>
                        <span>Automatically scrobble tracks to Last.fm once the delay threshold is reached</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-enabled" ${settings.enabled ? 'checked' : ''} />
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Save & Resume Progress on Pause / Skip / Restart</strong>
                        <span>Remembers how much of each song you already listened to if you pause, switch songs, or reopen Spotify</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-save-progress" ${settings.saveTrackProgress ? 'checked' : ''} />
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Sync Progress with Seek Bar (Pass Minutes)</strong>
                        <span>Updates scrobble progress when you scrub/skip ahead on the track timeline</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-sync-seek" ${settings.syncSeekProgress ? 'checked' : ''} />
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Send "Now Playing" Notifications</strong>
                        <span>Update your live "Scrobbling now" status on Last.fm when a song starts</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-nowplaying" ${settings.sendNowPlaying ? 'checked' : ''} />
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Scrobble Local Files</strong>
                        <span>Scrobble local MP3/FLAC tracks imported into Spotify (spotify:local)</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-local" ${settings.scrobbleLocalFiles ? 'checked' : ''} />
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Scrobble Podcasts & Episodes</strong>
                        <span>Include podcast episodes when listening in Spotify</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-podcasts" ${settings.scrobblePodcasts ? 'checked' : ''} />
                </div>
            </div>

            <div class="sfm-card">
                <strong style="display:block; margin-bottom:8px;">3. Pano Metadata Cleaners & UI Preferences</strong>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Auto-Strip "Remastered" Tags</strong>
                        <span>Cleans "- Remastered 2011", "(2019 Remaster)", etc. from track and album titles</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-remaster" ${settings.cleanRemastered ? 'checked' : ''} />
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Auto-Strip "Deluxe / Special Edition / Single" Tags</strong>
                        <span>Cleans "(Deluxe Edition)", "(Expanded Edition)", "- Single" from album names</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-deluxe" ${settings.cleanDeluxe ? 'checked' : ''} />
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Strip "(feat. ...)" from Track Titles</strong>
                        <span>Removes featured artist tags from song titles for cleaner Last.fm charts</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-feat" ${settings.cleanFeatFromTitle ? 'checked' : ''} />
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>First Artist Only (Primary Artist)</strong>
                        <span>Scrobble only the primary artist instead of combined multi-artist strings</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-first-artist" ${settings.firstArtistOnly ? 'checked' : ''} />
                </div>
                <div class="sfm-toggle-row">
                    <div class="sfm-toggle-label">
                        <strong>Show Toast Notification on Scrobble</strong>
                        <span>Display a small Spicetify toast whenever a song is scrobbled</span>
                    </div>
                    <input type="checkbox" id="sfm-chk-toast" ${settings.showNotifications ? 'checked' : ''} />
                </div>
            </div>
        `;

        container.querySelector('#sfm-open-api-create')?.addEventListener('click', () => {
            window.open('https://www.last.fm/api/account/create', '_blank');
        });

        const readCredInputs = () => {
            settings.apiKey = container.querySelector('#sfm-input-api-key')?.value.trim() || '';
            settings.apiSecret = container.querySelector('#sfm-input-api-secret')?.value.trim() || '';
            saveSettings();
        };

        container.querySelector('#sfm-save-creds-btn')?.addEventListener('click', () => {
            readCredInputs();
            notify('Saved Last.fm API Key & Shared Secret.');
            updateUI();
        });

        container.querySelector('#sfm-web-auth-btn')?.addEventListener('click', () => {
            readCredInputs();
            startDesktopWebAuth();
        });

        container.querySelector('#sfm-disconnect-btn')?.addEventListener('click', () => {
            stopAuthPolling();
            settings.sessionKey = '';
            settings.username = '';
            settings.userAvatar = '';
            settings.userTotalPlaycount = 0;
            saveSettings();
            notify('Disconnected from Last.fm.');
            updateUI();
        });

        const rangePct = container.querySelector('#sfm-range-pct');
        const lblPct = container.querySelector('#sfm-lbl-pct');
        rangePct?.addEventListener('input', () => {
            settings.thresholdPercent = Number(rangePct.value);
            if (lblPct) lblPct.textContent = `${settings.thresholdPercent}%`;
            saveSettings();
            if (currentSession) {
                currentSession.targetListenMs = calculateTargetListenMs(currentSession.durationMs);
            }
        });

        const rangeCap = container.querySelector('#sfm-range-cap');
        const lblCap = container.querySelector('#sfm-lbl-cap');
        rangeCap?.addEventListener('input', () => {
            settings.maxThresholdSeconds = Number(rangeCap.value);
            if (lblCap) lblCap.textContent = `${settings.maxThresholdSeconds}s`;
            saveSettings();
            if (currentSession) {
                currentSession.targetListenMs = calculateTargetListenMs(currentSession.durationMs);
            }
        });

        const bindCheckbox = (selector, key, refreshMeta = false) => {
            const el = container.querySelector(selector);
            el?.addEventListener('change', () => {
                settings[key] = Boolean(el.checked);
                saveSettings();
                if (refreshMeta) refreshCurrentSessionMetadata();
                updateUI();
            });
        };

        bindCheckbox('#sfm-chk-enabled', 'enabled');
        bindCheckbox('#sfm-chk-save-progress', 'saveTrackProgress');
        bindCheckbox('#sfm-chk-sync-seek', 'syncSeekProgress');
        bindCheckbox('#sfm-chk-nowplaying', 'sendNowPlaying');
        bindCheckbox('#sfm-chk-local', 'scrobbleLocalFiles', true);
        bindCheckbox('#sfm-chk-podcasts', 'scrobblePodcasts', true);
        bindCheckbox('#sfm-chk-remaster', 'cleanRemastered', true);
        bindCheckbox('#sfm-chk-deluxe', 'cleanDeluxe', true);
        bindCheckbox('#sfm-chk-feat', 'cleanFeatFromTitle', true);
        bindCheckbox('#sfm-chk-first-artist', 'firstArtistOnly', true);
        bindCheckbox('#sfm-chk-toast', 'showNotifications');
    }

    function updateUI() {
        updatePlaybarPill();
        if (isModalOpen) {
            renderModalContent();
        }
    }

    // ==================== INITIALIZATION ====================
    window.addEventListener(
        'keydown',
        e => {
            if (e.code === 'Escape' && isModalOpen) {
                e.preventDefault();
                closeDashboardModal();
                return;
            }
            if (e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyL') {
                e.preventDefault();
                if (isModalOpen) {
                    closeDashboardModal();
                } else {
                    openDashboardModal();
                }
            }
        },
        true
    );

    (async function registerMenuEntry() {
        for (let i = 0; i < 100 && !Spicetify.Menu?.Item; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        try {
            new Spicetify.Menu.Item(
                'SpicetifyFM (Last.fm)',
                false,
                () => openDashboardModal(),
                ICONS.lastfm
            ).register();
        } catch (err) {
            console.warn('[SpicetifyFM] Failed to register menu item:', err);
        }
    })();

    injectStyles();
    updatePlaybarPill();
    startNewTrackSession();

    // Refresh user profile stats & flush any pending offline queue on startup
    if (isAuthenticated()) {
        LastFmApi.getUserInfo(settings.username)
            .then(userInfo => {
                if (userInfo) {
                    settings.userTotalPlaycount = Number(userInfo.playcount || 0);
                    const imgs = userInfo.image;
                    if (Array.isArray(imgs) && imgs.length > 0) {
                        settings.userAvatar = imgs[imgs.length - 1]['#text'] || '';
                    }
                    saveSettings();
                }
            })
            .catch(() => {});

        if (offlineQueue.length > 0) {
            setTimeout(() => flushOfflineQueue(), 4000);
        }
    }

    console.log('[SpicetifyFM] Loaded In-App Last.fm Scrobbler v1.0.0');
})();
