const express = require('express');
const axios = require('axios');
const cors = require('cors');
const playdl = require('play-dl');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CORS - allow pulse app =====
app.use(cors({
  origin: ['https://rebelrexx.github.io', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// ===== CONFIG =====
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// ===== SPOTIFY TOKEN =====
let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const res = await axios.post(
      'https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    spotifyToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return spotifyToken;
  } catch (e) {
    console.error('Spotify token error:', e.message);
    throw new Error('Spotify auth failed');
  }
}

// ===== EXTRACT SPOTIFY ID =====
function extractSpotifyId(url) {
  // Handle formats:
  // https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
  // spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
  const match = url.match(/playlist[\/:]([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// ===== ROUTE: Health Check =====
app.get('/', (req, res) => {
  res.json({ status: 'Pulse Server Running', version: '1.0.0' });
});

// ===== ROUTE: Fetch Spotify Playlist =====
app.get('/spotify/playlist', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  const playlistId = extractSpotifyId(url);
  if (!playlistId) return res.status(400).json({ error: 'Invalid Spotify playlist URL' });

  try {
    const token = await getSpotifyToken();

    // Get playlist details
    const plRes = await axios.get(
      `https://api.spotify.com/v1/playlists/${playlistId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const pl = plRes.data;
    const tracks = [];

    // Fetch all tracks (handles pagination)
    let tracksUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50`;
    while (tracksUrl) {
      const tRes = await axios.get(tracksUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const items = tRes.data.items || [];
      items.forEach(item => {
        if (!item.track || item.track.type !== 'track') return;
        const t = item.track;
        tracks.push({
          spotifyId: t.id,
          title: t.name,
          artist: t.artists.map(a => a.name).join(', '),
          album: t.album?.name || '',
          duration: msToTime(t.duration_ms),
          durationMs: t.duration_ms,
          coverUrl: t.album?.images?.[0]?.url || '',
          previewUrl: t.preview_url || null,
        });
      });
      tracksUrl = tRes.data.next;
    }

    res.json({
      id: pl.id,
      name: pl.name,
      description: pl.description || '',
      coverUrl: pl.images?.[0]?.url || '',
      owner: pl.owner?.display_name || '',
      totalTracks: tracks.length,
      tracks,
    });

  } catch (e) {
    console.error('Spotify playlist error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== ROUTE: Get Audio URL for a song =====
app.get('/audio', async (req, res) => {
  const { title, artist, spotifyId } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });

  const query = `${title} ${artist || ''} official audio`;

  try {
    // Search YouTube
    const results = await playdl.search(query, { source: { youtube: 'video' }, limit: 5 });

    if (!results || results.length === 0) {
      return res.status(404).json({ error: 'No audio found' });
    }

    // Pick best match (first result, filter out long videos = concerts/albums)
    let best = results[0];
    for (const r of results) {
      if (r.durationInSec < 600) { // under 10 min
        best = r;
        break;
      }
    }

    // Get stream info
    const streamInfo = await playdl.stream(best.url, { quality: 2 });

    res.json({
      youtubeId: best.id,
      youtubeUrl: best.url,
      title: best.title,
      duration: best.durationRaw,
      streamUrl: null, // Direct stream not possible via redirect - use youtubeUrl
      thumbnail: best.thumbnails?.[0]?.url || '',
    });

  } catch (e) {
    console.error('Audio search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== ROUTE: Stream audio (proxy) =====
app.get('/stream', async (req, res) => {
  const { title, artist } = req.query;
  if (!title) return res.status(400).json({ error: 'title required' });

  const query = `${title} ${artist || ''} official audio`;

  try {
    const results = await playdl.search(query, { source: { youtube: 'video' }, limit: 5 });
    if (!results?.length) return res.status(404).json({ error: 'Not found' });

    let best = results[0];
    for (const r of results) {
      if (r.durationInSec < 600) { best = r; break; }
    }

    const stream = await playdl.stream(best.url, { quality: 2 });

    // Set headers for audio streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Song-Title', encodeURIComponent(best.title || ''));
    res.setHeader('X-Song-Duration', best.durationRaw || '');

    // Pipe audio stream to response
    stream.stream.pipe(res);

    stream.stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    });

    req.on('close', () => {
      stream.stream.destroy();
    });

  } catch (e) {
    console.error('Stream error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ===== ROUTE: Search songs =====
app.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q param required' });

  try {
    const results = await playdl.search(q + ' official audio', {
      source: { youtube: 'video' },
      limit: 8
    });

    res.json(results.filter(r => r.durationInSec < 600).map(r => ({
      id: r.id,
      title: r.title,
      url: r.url,
      duration: r.durationRaw,
      thumbnail: r.thumbnails?.[0]?.url || '',
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== HELPERS =====
function msToTime(ms) {
  if (!ms) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

app.listen(PORT, () => {
  console.log(`Pulse Server running on port ${PORT}`);
});
