// How a file's picture is labelled everywhere: Folders, Duplicates, the details page, the catalog.
// Width counts as well as height: a 4K film cropped to 2.39:1 is 3840×1608, not 2160 tall, and a
// 1080p one is 1920×800.
function resolution(v) {
  const w = v?.width || 0;
  const h = v?.height || 0;
  if (!w && !h) return null;
  return w >= 3200 || h >= 2000 ? '4K' : w >= 1800 || h >= 1000 ? '1080p' : w >= 1200 || h >= 700 ? '720p' : 'SD';
}

const RANK = { SD: 1, '720p': 2, '1080p': 3, '4K': 4 };

// Known only for files probed since HDR detection was added (they're re-probed once on the next scan).
function hdr(v) {
  if (v?.dolbyVision) return 'Dolby Vision';
  if (v?.colorTransfer === 'smpte2084') return 'HDR10';
  if (v?.colorTransfer === 'arib-std-b67') return 'HLG';
  return null;
}

module.exports = { resolution, hdr, RANK };
