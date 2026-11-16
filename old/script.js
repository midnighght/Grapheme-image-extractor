// ---------- Configuration ----------
const TARGET_W = 1472;
const TARGET_H = 2152;

const GRID = {
  startX: 16,
  startY: 16,
  cellW: 160,
  cellH: 212,
  colsPerRow: [9, 9, 9, 9, 9, 9, 9, 6, 6, 6], // 10 rows, 81 cells total
};

// Square cut inside each cell, offset relative to the cell's top-left corner
const CROP = { offsetX: 16, offsetY: 21, size: 128 };

// One name (without extension) per cell, read left to right, top to bottom.
const LETTERS = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ'.normalize('NFC').split(''); // 27 letters
const VOWELS = ['A', 'E', 'I', 'O', 'U'];

const NAMES = [
  ...LETTERS.map((l) => `${l}_mayus`),                       // 1-27
  ...LETTERS.map((l) => `${l.toLowerCase()}_minus`),         // 28-54
  ...'1234567890'.split(''),                                 // 55-64
  'punto', 'coma', 'dos_puntos', 'punto_coma', 'guion',      // 65-69
  ...VOWELS.map((v) => `${v}_tilde_mayus`),                  // 70-74
  'U_dier_mayus',                                            // 75
  ...VOWELS.map((v) => `${v.toLowerCase()}_tilde_minus`),    // 76-80
  'u_dier_minus',                                            // 81
].map((n) => n.normalize('NFC'));

// Folder for each range of cells (1-based, inclusive)
const FOLDERS = [
  { name: 'mayusculas', from: 1, to: 27 },
  { name: 'minusculas', from: 28, to: 54 },
  { name: 'numeros', from: 55, to: 64 },
  { name: 'simbolos', from: 65, to: 69 },
  { name: 'diacriticos', from: 70, to: 81 },
];

if (NAMES.length !== 81) console.warn(`Expected 81 names, got ${NAMES.length}`);

// Decides where each file goes inside the ZIP
function zipPathFor(name, index) {
  const n = index + 1;
  const folder = FOLDERS.find((f) => n >= f.from && n <= f.to);
  return folder ? `${folder.name}/${name}.png` : `${name}.png`;
}

// ---------- State ----------
let gray = null;            // Uint8ClampedArray, one luminance value per pixel
let scaled = null;          // Canvas with the original (color) image scaled to the fixed size
const $ = (id) => document.getElementById(id);
const preview = $('preview');
const pctx = preview.getContext('2d');
let results = [];           // { path, blob }
let thumbUrls = [];

preview.width = TARGET_W;
preview.height = TARGET_H;

// ---------- Helpers ----------
function setMsg(text, isError = false) {
  const el = $('msg');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

const toBlob = (canvas) =>
  new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));

async function loadImage(file) {
  // Applies EXIF orientation by default in current browsers
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(file);
  }
}

// ---------- Upload ----------
async function handleFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpe?g)$/.test(file.type)) {
    setMsg('Unsupported format. Use PNG or JPEG.', true);
    return;
  }
  let bmp;
  try {
    bmp = await loadImage(file);
  } catch {
    setMsg('Could not read that image. Try another file.', true);
    return;
  }
  if (bmp.width < TARGET_W || bmp.height < TARGET_H) {
    setMsg(`Image is ${bmp.width}×${bmp.height}. It must be at least ${TARGET_W}×${TARGET_H}.`, true);
    bmp.close?.();
    return;
  }

  // Scale (stretch) to the exact target size
  const work = document.createElement('canvas');
  work.width = TARGET_W;
  work.height = TARGET_H;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  wctx.imageSmoothingEnabled = true;
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(bmp, 0, 0, TARGET_W, TARGET_H);
  bmp.close?.();
  scaled = work;

  // Convert to grayscale
  const { data } = wctx.getImageData(0, 0, TARGET_W, TARGET_H);
  gray = new Uint8ClampedArray(TARGET_W * TARGET_H);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  setMsg(`Loaded ${file.name}, resized to ${TARGET_W}×${TARGET_H}.`);
  $('thresholdSection').hidden = false;
  $('resultSection').hidden = true;
  renderPreview();
}

// ---------- Threshold ----------
function buildBinary(threshold, invert) {
  const img = new ImageData(TARGET_W, TARGET_H);
  const out = img.data;
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    const white = gray[p] > threshold;
    const v = white !== invert ? 255 : 0;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = 255;
  }
  return img;
}

function renderPreview() {
  if (!gray) return;
  pctx.putImageData(buildBinary(+$('threshold').value, false), 0, 0);
}

$('threshold').addEventListener('input', (e) => {
  $('thresholdValue').textContent = e.target.value;
  renderPreview();
});

// ---------- Crop ----------
$('go').addEventListener('click', async () => {
  if (!gray) return;
  const btn = $('go');
  btn.disabled = true;
  btn.textContent = 'Processing…';

  try {
    // Inverted: symbols white on black
    const full = document.createElement('canvas');
    full.width = TARGET_W;
    full.height = TARGET_H;
    full.getContext('2d').putImageData(buildBinary(+$('threshold').value, true), 0, 0);

    const cell = document.createElement('canvas');
    cell.width = cell.height = CROP.size;
    const cctx = cell.getContext('2d');

    thumbUrls.forEach(URL.revokeObjectURL);
    thumbUrls = [];
    results = [];
    $('thumbs').replaceChildren();

    let idx = 0;
    for (let r = 0; r < GRID.colsPerRow.length; r++) {
      for (let c = 0; c < GRID.colsPerRow[r]; c++, idx++) {
        const sx = GRID.startX + c * GRID.cellW + CROP.offsetX;
        const sy = GRID.startY + r * GRID.cellH + CROP.offsetY;
        cctx.clearRect(0, 0, CROP.size, CROP.size);
        cctx.drawImage(full, sx, sy, CROP.size, CROP.size, 0, 0, CROP.size, CROP.size);
        const blob = await toBlob(cell);
        const name = NAMES[idx] ?? String(idx + 1);
        results.push({ path: zipPathFor(name, idx), blob });

        const url = URL.createObjectURL(blob);
        thumbUrls.push(url);
        const fig = document.createElement('figure');
        const img = document.createElement('img');
        img.src = url;
        img.alt = name;
        const cap = document.createElement('figcaption');
        cap.textContent = name;
        fig.append(img, cap);
        $('thumbs').append(fig);
      }
    }
    $('resultSection').hidden = false;
    $('resultSection').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    setMsg('Something went wrong while cropping. Please try again.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get images';
  }
});

// ---------- ZIP ----------
$('download').addEventListener('click', async () => {
  if (!results.length) return;
  const zip = new JSZip();
  results.forEach(({ path, blob }) => zip.file(path, blob));
  if (scaled) zip.file('plantilla.png', await toBlob(scaled)); // original image scaled to the fixed size
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'symbols.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- Input wiring ----------
$('file').addEventListener('change', (e) => handleFile(e.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
