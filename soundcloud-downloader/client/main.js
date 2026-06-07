import './style.css'

const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const errorMsg = document.getElementById('errorMsg');

const previewSection = document.getElementById('previewSection');
const artwork = document.getElementById('artwork');
const uploaderName = document.getElementById('uploaderName');
const trackTitle = document.getElementById('trackTitle');
const typeBadge = document.getElementById('typeBadge');
const durationBadge = document.getElementById('durationBadge');

const downloadBtn = document.getElementById('downloadBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const statsText = document.getElementById('statsText');
const cancelBtn = document.getElementById('cancelBtn');

// Modal Elements
const infoBtn = document.getElementById('infoBtn');
const infoModal = document.getElementById('infoModal');
const closeModalBtn = document.getElementById('closeModalBtn');

let currentUrl = '';
let activeJobId = null;

function formatTime(seconds) {
  if (!seconds) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Modal Listeners
infoBtn.addEventListener('click', () => infoModal.classList.remove('hidden'));
closeModalBtn.addEventListener('click', () => infoModal.classList.add('hidden'));
infoModal.addEventListener('click', (e) => {
  if (e.target === infoModal) infoModal.classList.add('hidden');
});

// Cancel Listener
cancelBtn.addEventListener('click', async () => {
  if (!activeJobId) return;
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Cancelling...';
  try {
    await fetch(`/api/download/${activeJobId}`, { method: 'DELETE' });
  } catch (err) {
    console.error('Failed to cancel job', err);
  }
});

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) {
    errorMsg.textContent = 'Please enter a valid URL';
    return;
  }
  
  errorMsg.textContent = '';
  fetchBtn.classList.add('disabled');
  fetchBtn.querySelector('span').textContent = 'Analyzing...';
  previewSection.classList.add('hidden');
  progressContainer.classList.add('hidden');
  statsText.classList.add('hidden');
  downloadBtn.classList.remove('hidden');
  activeJobId = null;

  try {
    const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to analyze link');

    // Populate UI
    currentUrl = url;
    uploaderName.textContent = data.uploader;
    trackTitle.textContent = data.title;
    
    // Some track images come as small variants, try to get t500x500
    let imgUrl = data.thumbnail || 'https://via.placeholder.com/500?text=No+Cover';
    if(imgUrl.includes('-large.jpg')) {
      imgUrl = imgUrl.replace('-large.jpg', '-t500x500.jpg');
    }
    artwork.src = imgUrl;

    if (data.isPlaylist) {
      typeBadge.textContent = data.entries === 'Multiple' ? data.badgeStr : `Collection (${data.entries} tracks)`;
      durationBadge.classList.add('hidden');
    } else {
      typeBadge.textContent = data.uploader === 'Spotify' ? data.badgeStr : 'Single Track';
      durationBadge.classList.remove('hidden');
      durationBadge.textContent = formatTime(data.duration);
    }

    previewSection.classList.remove('hidden');
  } catch (err) {
    errorMsg.textContent = err.message;
  } finally {
    fetchBtn.classList.remove('disabled');
    fetchBtn.querySelector('span').textContent = 'Analyze';
  }
}

async function startDownload() {
  if (!currentUrl) return;

  downloadBtn.classList.add('hidden');
  progressContainer.classList.remove('hidden');
  statsText.classList.add('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = 'Connecting...';
  progressText.style.color = 'var(--text-primary)';
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel';
  cancelBtn.classList.remove('hidden');

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentUrl })
    });

    if (!res.ok) throw new Error('Download request failed');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n\n');

      for (let line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            if (data.type === 'jobId') {
              activeJobId = data.id;
            } else if (data.type === 'progress') {
              progressBar.style.width = `${data.percent}%`;
              progressText.textContent = `Downloading... ${data.percent}%`;
            } else if (data.type === 'log') {
              if(data.message.includes('Destination')) {
                progressText.textContent = 'Converting to MP3...';
              } else if (data.message.match(/Downloaded|Searching|Found/i)) {
                progressText.textContent = data.message;
                if (!progressBar.style.width || progressBar.style.width === '0%') {
                  progressBar.style.width = '50%'; // fake progress for spotdl since it doesn't emit pure % reliably
                }
              }
            } else if (data.type === 'error') {
               progressText.textContent = data.message;
               progressText.style.color = 'var(--error)';
               cancelBtn.classList.add('hidden');
            } else if (data.type === 'done') {
              progressBar.style.width = `100%`;
              progressText.textContent = 'Starting file download...';
              progressText.style.color = 'var(--success)';
              cancelBtn.classList.add('hidden');
              
              // Trigger actual file download from the browser
              const a = document.createElement('a');
              a.href = data.downloadUrl;
              a.style.display = 'none';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);

              // Show success vs fail metrics
              statsText.textContent = `Successfully Downloaded: ${data.downloaded} tracks | Failed: ${data.failed} tracks`;
              statsText.classList.remove('hidden');
            }
          } catch (e) {
            // Ignore parse errors on partial chunks
          }
        }
      }
    }
  } catch (err) {
    progressText.textContent = 'Error starting download';
    progressText.style.color = 'var(--error)';
    cancelBtn.classList.add('hidden');
  }
}

fetchBtn.addEventListener('click', fetchInfo);
urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') fetchInfo();
});
downloadBtn.addEventListener('click', startDownload);

// --- Matrix Rain Background ---
const canvas = document.getElementById('matrixCanvas');
if (canvas) {
  const ctx = canvas.getContext('2d');

  let width, height;
  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  const colors = ['#D52D00', '#FF9A56', '#FFFFFF', '#D362A4', '#A30262'];
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()';
  const fontSize = 16;
  let columns = Math.floor(width / fontSize);
  let drops = [];
  let dropColors = [];

  function initMatrix() {
    columns = Math.floor(width / fontSize);
    drops = [];
    dropColors = [];
    for (let x = 0; x < columns; x++) {
      drops[x] = Math.random() * -100;
      dropColors[x] = colors[Math.floor(Math.random() * colors.length)];
    }
  }
  initMatrix();
  window.addEventListener('resize', initMatrix);

  function drawMatrix() {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.1)'; 
    ctx.fillRect(0, 0, width, height);

    ctx.font = fontSize + 'px monospace';

    for (let i = 0; i < drops.length; i++) {
      const text = chars.charAt(Math.floor(Math.random() * chars.length));
      
      ctx.fillStyle = dropColors[i];
      ctx.fillText(text, i * fontSize, drops[i] * fontSize);

      if (drops[i] * fontSize > height && Math.random() > 0.975) {
        drops[i] = 0;
        dropColors[i] = colors[Math.floor(Math.random() * colors.length)];
      }
      drops[i]++;
    }
  }

  setInterval(drawMatrix, 50);
}
