// Image settings, built-in presets and helpers for per-image changes.

export const MODES = [
  { value: 'original', label: 'Original', tip: 'Keep the colours as they are (sliders still apply).' },
  { value: 'color', label: 'Enhanced colour', tip: 'Cleaner, slightly stronger colours.' },
  { value: 'gray', label: 'Grayscale', tip: 'Shades of grey.' },
  { value: 'bw', label: 'Black and white', tip: 'Pure black lines on white (adaptive threshold).' },
  { value: 'lineart', label: 'Line art', tip: 'Black and white with smooth edges. Best for clean diagrams.' },
];

export const TOGGLES = [
  { key: 'adaptive', label: 'Leave clean crops untouched', tip: 'Crops that already have white paper and no grain (digital PDFs) keep their exact colours and fills.' },
  { key: 'whiteBg', label: 'White background', tip: 'Turn grey, yellow or uneven paper into clean white.' },
  { key: 'shadow', label: 'Remove shadows and uneven light', tip: 'Flatten the lighting across the crop.' },
  { key: 'keepColor', label: 'Keep coloured lines', tip: 'Keep colours (for example coloured curves) in Grayscale, Black and white and Line art.' },
  { key: 'protectLines', label: 'Protect thin lines when sharpening', tip: 'Sharpen without halos or thinning fine lines.' },
  { key: 'autoDeskew', label: 'Straighten tilt automatically', tip: 'Detect and fix a slightly tilted crop on every image.' },
  { key: 'trim', label: 'Auto trim white border', tip: 'Remove extra white space around the diagram.' },
];

export const SLIDERS = [
  { key: 'enhance', label: 'Auto enhance strength', min: 0, max: 100, step: 1, tip: 'Background clean-up, contrast and sharpening together.' },
  { key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1 },
  { key: 'gamma', label: 'Gamma', min: 0.3, max: 3, step: 0.05, tip: 'Above 1 lightens mid tones, below 1 darkens them.' },
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.1 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1, tip: 'Lighten or darken the dark tones.' },
  { key: 'whitePoint', label: 'White point', min: 128, max: 255, step: 1, tip: 'Everything brighter than this becomes white.' },
  { key: 'blackPoint', label: 'Black point', min: 0, max: 127, step: 1, tip: 'Everything darker than this becomes black.' },
  { key: 'sharpen', label: 'Sharpness (fix blur)', min: 0, max: 100, step: 1 },
  { key: 'denoise', label: 'Denoise', min: 0, max: 100, step: 1, tip: 'Smooth phone-camera grain while keeping edges.' },
  { key: 'despeckle', label: 'Despeckle (dot size)', min: 0, max: 10, step: 1, tip: 'Remove dots up to this size. Thin lines are kept.' },
  { key: 'threshold', label: 'Black and white strength', min: 0, max: 100, step: 1, tip: 'Higher keeps more (and fainter) ink.' },
];

export const OUTPUT = {
  padding: { label: 'White padding', min: 0, max: 40, step: 1 },
  widths: [0, 800, 1000, 1200, 1600, 2000],
  heights: [0, 600, 800, 1000, 1200, 1600],
  formats: [
    { value: 'png', label: 'PNG' },
    { value: 'png8', label: 'PNG-8 (small, up to 256 colours)' },
    { value: 'jpg', label: 'JPG' },
  ],
};

/** Neutral values: no change at all. */
export const NEUTRAL = {
  mode: 'original', adaptive: true, whiteBg: false, shadow: false, keepColor: true, protectLines: true, autoDeskew: false, trim: true,
  enhance: 0, brightness: 0, contrast: 0, gamma: 1, exposure: 0, highlights: 0, shadows: 0, whitePoint: 255, blackPoint: 0,
  sharpen: 0, denoise: 0, despeckle: 0, threshold: 50,
  padding: 10, maxWidth: 1200, maxHeight: 0, format: 'png', jpgQuality: 90,
};

export const SETTING_KEYS = Object.keys(NEUTRAL);

export const BUILT_IN = [
  {
    id: 'phone', name: 'Phone photo - clean', builtIn: true,
    settings: { ...NEUTRAL, mode: 'color', whiteBg: true, shadow: true, enhance: 60, sharpen: 35, denoise: 25, despeckle: 3 },
  },
  {
    id: 'scan', name: 'Scanned - light', builtIn: true,
    settings: { ...NEUTRAL, mode: 'color', whiteBg: true, shadow: false, enhance: 30, sharpen: 20, denoise: 5, despeckle: 1 },
  },
  {
    id: 'color', name: 'Coloured diagram', builtIn: true,
    settings: { ...NEUTRAL, mode: 'color', whiteBg: true, shadow: true, keepColor: true, enhance: 40, sharpen: 25, denoise: 15, despeckle: 2 },
  },
  {
    id: 'text', name: 'Text-heavy (black and white)', builtIn: true,
    settings: { ...NEUTRAL, mode: 'bw', whiteBg: true, shadow: true, keepColor: false, enhance: 40, sharpen: 20, denoise: 20, despeckle: 3, threshold: 55, format: 'png8' },
  },
  {
    id: 'none', name: 'No changes (digital PDF)', builtIn: true,
    settings: { ...NEUTRAL },
  },
];

export const DEFAULT_PRESET_ID = 'phone';

export function sanitizeSettings(s) {
  const out = { ...NEUTRAL };
  for (const k of SETTING_KEYS) if (s && s[k] !== undefined && typeof s[k] === typeof NEUTRAL[k]) out[k] = s[k];
  return out;
}

export function sanitizePresets(list) {
  const custom = (Array.isArray(list) ? list : [])
    .filter((p) => p && p.id && p.name && !BUILT_IN.some((b) => b.id === p.id))
    .map((p) => ({ id: String(p.id), name: String(p.name).slice(0, 60), builtIn: false, settings: sanitizeSettings(p.settings) }));
  return [...BUILT_IN.map((b) => ({ ...b, settings: { ...b.settings } })), ...custom];
}

/** Only the settings that differ from the preset. */
export function diff(settings, base) {
  const out = {};
  for (const k of SETTING_KEYS) if (settings[k] !== undefined && settings[k] !== base[k]) out[k] = settings[k];
  return out;
}

export const emptyGeom = () => ({ rot90: 0, angle: 0, deskew: null, flipH: false, flipV: false, persp: null, crop: null });

export function newEdit(presetId, overrides) {
  return { presetId, overrides: { ...(overrides || {}) }, geom: emptyGeom(), ops: [] };
}

/** True when an image has its own settings or edit steps. */
export function isCustom(edit) {
  if (!edit) return false;
  const g = edit.geom || {};
  return Object.keys(edit.overrides || {}).length > 0 || (edit.ops || []).length > 0
    || !!g.persp || !!g.crop || !!g.rot90 || !!g.angle || !!g.flipH || !!g.flipV || (!g.deskewAuto && g.deskew !== null && g.deskew !== undefined && g.deskew !== 0);
}

export function customSummary(edit) {
  if (!edit) return '';
  const g = edit.geom || {};
  const bits = [];
  const n = Object.keys(edit.overrides || {}).length;
  if (n) bits.push(`${n} setting${n === 1 ? '' : 's'} changed`);
  if ((edit.ops || []).length) bits.push(`${edit.ops.length} clean-up step${edit.ops.length === 1 ? '' : 's'}`);
  if (g.rot90 || g.angle || g.flipH || g.flipV) bits.push('rotated or flipped');
  if (g.deskew && !g.deskewAuto) bits.push(`tilt fixed (${g.deskew}°)`);
  if (g.persp) bits.push('perspective fixed');
  if (g.crop) bits.push('fine cropped');
  return bits.join(', ');
}
