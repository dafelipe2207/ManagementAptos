// lib/qr.js — tiny self-contained QR code generator (byte mode, error correction level M,
// versions 1–10, i.e. up to 213 bytes — plenty for a Wi-Fi join code). No external library, so
// it works offline and doesn't depend on a CDN. Exposes window.makeQrSvg(text) → '<svg …>'.
(function(){
  // --- Galois field GF(256) with the QR polynomial 0x11d ---
  var EXP = new Array(512), LOG = new Array(256);
  (function(){ var x = 1; for (var i = 0; i < 255; i++){ EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255]; })();
  function gmul(a, b){ return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
  function rsGenerator(degree){
    var g = [1];
    for (var i = 0; i < degree; i++){
      var next = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j++){ next[j] ^= g[j]; next[j + 1] ^= gmul(g[j], EXP[i]); }
      g = next;
    }
    return g;
  }
  function rsEncode(data, ecLen){
    var gen = rsGenerator(ecLen), res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++){
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      for (var j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  // Level M: [ecCodewordsPerBlock, [ [blockCount, dataCodewordsPerBlock], ... ] ] for versions 1..10
  var M = [null,
    [10, [[1,16]]], [16, [[1,28]]], [26, [[1,44]]], [18, [[2,32]]], [24, [[2,43]]],
    [16, [[4,27]]], [18, [[4,31]]], [22, [[2,38],[2,39]]], [22, [[3,36],[2,37]]], [26, [[4,43],[1,44]]]];
  var ALIGN = [null, [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50]];

  function utf8(text){
    var out = [], s = unescape(encodeURIComponent(text));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }
  function dataCapacity(v){ return M[v][1].reduce(function(s, b){ return s + b[0] * b[1]; }, 0); }

  function encodeData(bytes){
    var v;
    for (v = 1; v <= 10; v++){
      var countBits = v < 10 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= dataCapacity(v) * 8) break;
    }
    if (v > 10) throw new Error('Text too long for a QR code');
    var bits = [];
    function put(val, len){ for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
    bytes.forEach(function(b){ put(b, 8); });
    var capBits = dataCapacity(v) * 8;
    put(0, Math.min(4, capBits - bits.length));
    while (bits.length % 8) bits.push(0);
    var cw = [];
    for (var i = 0; i < bits.length; i += 8){ var b = 0; for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k]; cw.push(b); }
    for (var pad = 0; cw.length < dataCapacity(v); pad++) cw.push(pad % 2 ? 0x11 : 0xEC);
    // split into blocks, add error correction, interleave
    var ecLen = M[v][0], blocks = [], pos = 0;
    M[v][1].forEach(function(g){ for (var n = 0; n < g[0]; n++){ var d = cw.slice(pos, pos + g[1]); pos += g[1]; blocks.push({ d: d, e: rsEncode(d, ecLen) }); } });
    var out = [], maxD = Math.max.apply(null, blocks.map(function(b){ return b.d.length; }));
    for (var i2 = 0; i2 < maxD; i2++) blocks.forEach(function(b){ if (i2 < b.d.length) out.push(b.d[i2]); });
    for (var j = 0; j < ecLen; j++) blocks.forEach(function(b){ out.push(b.e[j]); });
    return { version: v, codewords: out };
  }

  function bchFormat(data){ // 5 bits → 15-bit format word
    var d = data << 10, g = 0x537;
    for (var i = 14; i >= 10; i--) if ((d >>> i) & 1) d ^= g << (i - 10);
    return ((data << 10) | d) ^ 0x5412;
  }
  function bchVersion(v){
    var d = v << 12, g = 0x1F25;
    for (var i = 17; i >= 12; i--) if ((d >>> i) & 1) d ^= g << (i - 12);
    return (v << 12) | d;
  }
  var MASKS = [
    function(r,c){ return (r + c) % 2 === 0; }, function(r){ return r % 2 === 0; },
    function(r,c){ return c % 3 === 0; }, function(r,c){ return (r + c) % 3 === 0; },
    function(r,c){ return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function(r,c){ return (r * c) % 2 + (r * c) % 3 === 0; },
    function(r,c){ return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function(r,c){ return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }];

  function build(enc, mask){
    var v = enc.version, n = 17 + 4 * v;
    var m = [], fn = [];
    for (var i = 0; i < n; i++){ m.push(new Array(n).fill(0)); fn.push(new Array(n).fill(false)); }
    function set(r, c, val){ m[r][c] = val ? 1 : 0; fn[r][c] = true; }
    function finder(r, c){
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++){
        var rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        var on = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
        set(rr, cc, on);
      }
    }
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    for (var t = 8; t < n - 8; t++){ set(6, t, t % 2 === 0); set(t, 6, t % 2 === 0); }
    var al = ALIGN[v];
    var last = al.length - 1;
    al.forEach(function(r, ai){ al.forEach(function(c, aj){
      if ((ai === 0 && aj === 0) || (ai === 0 && aj === last) || (ai === last && aj === 0)) return; // would overlap a finder
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }); });
    set(n - 8, 8, true); // dark module
    // reserve format + version areas
    for (var k = 0; k < 9; k++){ if (!fn[8][k]) set(8, k, 0); if (!fn[k][8]) set(k, 8, 0); }
    for (var k2 = 0; k2 < 8; k2++){ set(8, n - 1 - k2, 0); set(n - 1 - k2, 8, 0); }
    if (v >= 7){ for (var a = 0; a < 6; a++) for (var b = 0; b < 3; b++){ set(n - 11 + b, a, 0); set(a, n - 11 + b, 0); } }
    // data
    var bitIdx = 0, total = enc.codewords.length * 8, up = true;
    for (var col = n - 1; col > 0; col -= 2){
      if (col === 6) col--;
      for (var step = 0; step < n; step++){
        var row = up ? n - 1 - step : step;
        for (var cOff = 0; cOff < 2; cOff++){
          var cc2 = col - cOff;
          if (fn[row][cc2]) continue;
          var bit = 0;
          if (bitIdx < total){ bit = (enc.codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1; bitIdx++; }
          if (MASKS[mask](row, cc2)) bit ^= 1;
          m[row][cc2] = bit;
        }
      }
      up = !up;
    }
    // format info (level M = 00)
    var f = bchFormat((0 << 3) | mask);
    for (var i3 = 0; i3 < 15; i3++){
      var fb = (f >>> i3) & 1;
      // first copy, around the top-left finder
      if (i3 < 6) m[i3][8] = fb;
      else if (i3 === 6) m[7][8] = fb;
      else if (i3 === 7) m[8][8] = fb;
      else if (i3 === 8) m[8][7] = fb;
      else m[8][14 - i3] = fb;
      // second copy, split between the top-right and bottom-left finders
      if (i3 < 8) m[8][n - 1 - i3] = fb; else m[n - 15 + i3][8] = fb;
    }
    m[n - 8][8] = 1;
    if (v >= 7){
      var vb = bchVersion(v);
      for (var i4 = 0; i4 < 18; i4++){
        var bit2 = (vb >>> i4) & 1, r2 = Math.floor(i4 / 3), c2 = i4 % 3 + n - 11;
        m[r2][c2] = bit2; m[c2][r2] = bit2;
      }
    }
    return m;
  }

  function penalty(m){
    var n = m.length, p = 0, r, c;
    for (r = 0; r < n; r++){ // runs in rows and columns
      for (var dir = 0; dir < 2; dir++){
        var run = 1;
        for (c = 1; c < n; c++){
          var a = dir ? m[c][r] : m[r][c], b = dir ? m[c - 1][r] : m[r][c - 1];
          if (a === b){ run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
      }
    }
    for (r = 0; r < n - 1; r++) for (c = 0; c < n - 1; c++){
      var s = m[r][c] + m[r + 1][c] + m[r][c + 1] + m[r + 1][c + 1];
      if (s === 0 || s === 4) p += 3;
    }
    var pat1 = [1,0,1,1,1,0,1,0,0,0,0], pat2 = [0,0,0,0,1,0,1,1,1,0,1];
    for (r = 0; r < n; r++) for (c = 0; c <= n - 11; c++){
      var h1 = true, h2 = true, v1 = true, v2 = true;
      for (var k = 0; k < 11; k++){
        if (m[r][c + k] !== pat1[k]) h1 = false; if (m[r][c + k] !== pat2[k]) h2 = false;
        if (m[c + k][r] !== pat1[k]) v1 = false; if (m[c + k][r] !== pat2[k]) v2 = false;
      }
      p += 40 * ((h1?1:0) + (h2?1:0) + (v1?1:0) + (v2?1:0));
    }
    var dark = 0; for (r = 0; r < n; r++) for (c = 0; c < n; c++) dark += m[r][c];
    p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
    return p;
  }

  function makeQrMatrix(text){
    var enc = encodeData(utf8(text)), best = null, bestP = Infinity;
    for (var mask = 0; mask < 8; mask++){ var mm = build(enc, mask), pp = penalty(mm); if (pp < bestP){ bestP = pp; best = mm; } }
    return best;
  }
  function makeQrSvg(text){
    var m = makeQrMatrix(text), n = m.length, q = 3, size = n + q * 2, d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (m[r][c]) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  window.makeQrMatrix = makeQrMatrix;
  window.makeQrSvg = makeQrSvg;
})();
