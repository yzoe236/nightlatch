/* ProfileLock lock-screen themes. Shared by content overlay,
 * locked.html and the options picker. */
(function (root) {
  'use strict';
  root.PLK_THEMES = {
    dark: {
      name: 'Graphite (default)',
      bg: '#0b0d12', fg: '#e8eaed', sub: 'rgba(232,234,237,.55)',
      inputBg: '#202124', inputBorder: '#3c4043', accent: '#8ab4f8', accentFg: '#202124', err: '#f28b82'
    },
    midnight: {
      name: 'Midnight',
      bg: 'linear-gradient(135deg,#0f2027,#203a43,#2c5364)', fg: '#eaf6ff', sub: 'rgba(234,246,255,.6)',
      inputBg: 'rgba(0,0,0,.35)', inputBorder: '#3f6273', accent: '#7cd1f9', accentFg: '#0f2027', err: '#ffb4a9'
    },
    aurora: {
      name: 'Aurora',
      bg: 'linear-gradient(135deg,#1a1a2e,#16213e,#0f3460)', fg: '#f1f1f6', sub: 'rgba(241,241,246,.6)',
      inputBg: 'rgba(0,0,0,.35)', inputBorder: '#3d4b7d', accent: '#e94560', accentFg: '#ffffff', err: '#ffb4a9'
    },
    paper: {
      name: 'Paper (light)',
      bg: '#f2f4f8', fg: '#202124', sub: 'rgba(32,33,36,.6)',
      inputBg: '#ffffff', inputBorder: '#c4c7cc', accent: '#1a73e8', accentFg: '#ffffff', err: '#c5221f'
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
