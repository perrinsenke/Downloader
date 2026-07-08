const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(os.tmpdir(), 'soundcloud-dl-jobs');
const SPOTDL_BIN = process.env.NODE_ENV === 'production' ? 'spotdl' : path.join(os.homedir(), '.local', 'bin', 'spotdl');

// Serve static frontend files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
}

// Ensure base temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Helper to run spotdl save and parse JSON metadata for Spotify
function getSpotifyMeta(url) {
  return new Promise((resolve, reject) => {
    const metaFile = path.join(TEMP_DIR, `meta-${crypto.randomUUID()}.spotdl`);
    const proc = spawn(SPOTDL_BIN, ['save', url, '--save-file', metaFile]);
    let errorOutput = '';

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      try {
        if (!fs.existsSync(metaFile)) {
          return reject(new Error(`spotdl failed to save metadata: ${errorOutput}`));
        }
        const raw = fs.readFileSync(metaFile, 'utf-8');
        const tracks = JSON.parse(raw);
        fs.unlinkSync(metaFile);
        resolve(tracks); // Array of track objects
      } catch (err) {
        try { fs.unlinkSync(metaFile); } catch (e) {}
        reject(new Error(`Failed to parse spotdl metadata: ${err.message}`));
      }
    });
  });
}

// Helper to run yt-dlp and parse JSON output for SoundCloud
function getTrackInfo(url) {
  return new Promise((resolve, reject) => {
    const ytDlp = spawn('yt-dlp', ['-J', '--flat-playlist', url]);
    let output = '';
    let errorOutput = '';

    ytDlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytDlp.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ytDlp.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp failed: ${errorOutput}`));
      }
      try {
        const parsed = JSON.parse(output);
        resolve(parsed);
      } catch (err) {
        reject(new Error('Failed to parse yt-dlp output'));
      }
    });
  });
}

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const isSpotify = url.includes('spotify.com');

  try {
    if (isSpotify) {
      const isPlaylist = url.includes('/playlist/') || url.includes('/album/') || url.includes('/artist/');
      let typeBadgeStr = 'Spotify Track';

      if (url.includes('/playlist/')) { typeBadgeStr = 'Spotify Playlist'; }
      else if (url.includes('/album/')) { typeBadgeStr = 'Spotify Album'; }
      else if (url.includes('/artist/')) { typeBadgeStr = 'Spotify Artist'; }

      try {
        const tracks = await getSpotifyMeta(url);

        if (!tracks || tracks.length === 0) {
          return res.status(500).json({ error: 'No tracks found for this Spotify URL.' });
        }

        const firstTrack = tracks[0];
        let title, uploader, thumbnail;

        if (isPlaylist) {
          title = firstTrack.list_name || firstTrack.album_name || typeBadgeStr;
          uploader = firstTrack.list_name ? 'Spotify Playlist' : firstTrack.album_artist || firstTrack.artist;
          thumbnail = firstTrack.cover_url || null;
        } else {
          title = firstTrack.name;
          uploader = firstTrack.artist;
          thumbnail = firstTrack.cover_url || null;
        }

        return res.json({
          title,
          uploader,
          thumbnail,
          isPlaylist,
          entries: tracks.length,
          duration: !isPlaylist ? firstTrack.duration : null,
          badgeStr: typeBadgeStr,
          tracks: tracks.map(t => ({
            name: t.name,
            artist: t.artist,
            duration: t.duration,
          })),
        });
      } catch (metaErr) {
        console.error('Spotify meta error:', metaErr.message);
        // Fallback to basic info if spotdl save fails
        let titleStr = url.split('/').pop().split('?')[0];
        if (url.includes('/playlist/')) { titleStr = 'Spotify Playlist'; }
        else if (url.includes('/album/')) { titleStr = 'Spotify Album'; }
        else if (url.includes('/artist/')) { titleStr = 'Spotify Artist Profile'; }

        return res.json({
          title: titleStr,
          uploader: 'Spotify',
          thumbnail: 'https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png',
          isPlaylist,
          entries: isPlaylist ? 'Multiple' : 1,
          duration: null,
          badgeStr: typeBadgeStr,
          tracks: null,
        });
      }
    }

    const info = await getTrackInfo(url);
    const isPlaylist = info._type === 'playlist' || info._type === 'url_transparent';
    
    res.json({
      title: info.title || info.playlist_title || 'Unknown Track',
      uploader: info.uploader || info.playlist_uploader || 'Unknown',
      thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || null,
      isPlaylist,
      entries: isPlaylist ? info.playlist_count || info.entries?.length : 1,
      duration: isPlaylist ? null : info.duration,
    });
  } catch (error) {
    console.error('Info Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch information. Check the link.' });
  }
});

const activeJobs = new Map();

app.delete('/api/download/:id', (req, res) => {
  const { id } = req.params;
  if (activeJobs.has(id)) {
    const proc = activeJobs.get(id);
    proc.kill('SIGTERM');
    activeJobs.delete(id);
    return res.json({ success: true, message: 'Download cancelled' });
  }
  res.status(404).json({ error: 'Job not found or already completed' });
});

app.post('/api/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const jobId = crypto.randomUUID();
  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Instantly send jobId to client
  res.write(`data: ${JSON.stringify({ type: 'jobId', id: jobId })}\n\n`);

  const isSpotify = url.includes('spotify.com');
  let childProc;
  let failedCount = 0;
  let spotifyTotal = 0;
  let spotifyDone = 0;

  if (isSpotify) {
    const outputTemplate = path.join(jobDir, '{artist} - {title}.{ext}');
    const args = [
      'download',
      url,
      '--output', outputTemplate,
      '--format', 'mp3',
      '--bitrate', '320k',
      '--threads', '4',
    ];
    childProc = spawn(SPOTDL_BIN, args);
  } else {
    // Save flat inside jobDir to allow easy zipping
    const outputTemplate = path.join(jobDir, '%(title)s.%(ext)s');
    const args = [
      '-o', outputTemplate,
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-thumbnail', '--embed-metadata',
      '--downloader', 'aria2c',
      '--downloader-args', 'aria2c:-x 16 -s 16 -k 1M',
      url
    ];
    childProc = spawn('yt-dlp', args);
  }

  activeJobs.set(jobId, childProc);

  childProc.stdout.on('data', (data) => {
    const text = data.toString();
    
    if (isSpotify) {
      // Track total from spotdl's "Found N songs" line
      const foundMatch = text.match(/Found (\d+) songs?/i);
      if (foundMatch) {
        spotifyTotal = parseInt(foundMatch[1]);
        res.write(`data: ${JSON.stringify({ type: 'log', message: `Found ${spotifyTotal} tracks to download` })}\n\n`);
      }

      // Count completed downloads for real progress
      if (text.includes('Downloaded') || text.includes('Skipping')) {
        spotifyDone++;
        if (spotifyTotal > 0) {
          const pct = Math.round((spotifyDone / spotifyTotal) * 100);
          res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);
        }
      }

      // Track failures
      if (text.includes('Could not match') || text.includes('LookupError')) {
        failedCount++;
      }

      // Forward meaningful log lines
      res.write(`data: ${JSON.stringify({ type: 'log', message: text.trim() })}\n\n`);
    } else {
      // Attempt progress extraction for yt-dlp
      const ytProgress = text.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (ytProgress) {
        res.write(`data: ${JSON.stringify({ type: 'progress', percent: parseFloat(ytProgress[1]) })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'log', message: text.trim() })}\n\n`);
      }
    }
  });

  childProc.stderr.on('data', (data) => {
    const text = data.toString();
    console.error(`Process error: ${text}`);
    
    // Failure tracking from stderr (both yt-dlp and spotdl)
    if (text.includes('ERROR:') || text.includes('LookupError') || text.includes('HTTPError')) {
      failedCount++;
    }

    // spotdl also emits progress info to stderr
    if (isSpotify) {
      const foundMatch = text.match(/Found (\d+) songs?/i);
      if (foundMatch) {
        spotifyTotal = parseInt(foundMatch[1]);
        res.write(`data: ${JSON.stringify({ type: 'log', message: `Found ${spotifyTotal} tracks to download` })}\n\n`);
      }
      if (text.includes('Downloaded') || text.includes('Skipping')) {
        spotifyDone++;
        if (spotifyTotal > 0) {
          const pct = Math.round((spotifyDone / spotifyTotal) * 100);
          res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);
        }
      }
      if (text.includes('Could not match') || text.includes('LookupError')) {
        failedCount++;
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'error', message: text.trim() })}\n\n`);
  });

  childProc.on('close', (code, signal) => {
    activeJobs.delete(jobId);

    if (signal === 'SIGTERM') {
      try {
        fs.rmSync(jobDir, { recursive: true, force: true });
      } catch (e) {}
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Download cancelled by user.' })}\n\n`);
      return res.end();
    }

    try {
      const files = fs.readdirSync(jobDir).filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));
      const downloadedCount = files.length;
      
      if (downloadedCount === 0) {
        fs.rmSync(jobDir, { recursive: true, force: true });
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'No tracks were downloaded successfully.' })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ 
          type: 'done', 
          message: 'Processing complete!', 
          downloadUrl: `/api/serve?id=${jobId}`,
          downloaded: downloadedCount,
          failed: failedCount
        })}\n\n`);
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to read downloaded files.' })}\n\n`);
    }
    res.end();
  });
});

app.get('/api/serve', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('Job ID required');

  const jobDir = path.join(TEMP_DIR, id);
  if (!fs.existsSync(jobDir)) {
    return res.status(404).send('Download expired or not found.');
  }

  const files = fs.readdirSync(jobDir).filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));
  
  if (files.length === 0) {
    fs.rmSync(jobDir, { recursive: true, force: true });
    return res.status(404).send('No valid files found.');
  }

  res.on('finish', () => {
    // Cleanup folder after sending
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch (err) {
      console.error('Failed to cleanup job dir:', err);
    }
  });

  if (files.length === 1) {
    // Send single file directly
    const filePath = path.join(jobDir, files[0]);
    res.download(filePath);
  } else {
    // Zip playlist and send
    res.attachment('Playlist.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      res.status(500).end();
    });

    archive.pipe(res);
    archive.directory(jobDir, false);
    archive.finalize();
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
