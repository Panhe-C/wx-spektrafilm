// Film borders (胶片边框): pure layout math plus a Canvas 2D painter.
//
// The border is added AROUND the graded picture: the picture keeps its pixels
// and the frame is composited afterwards, so the border itself is never
// graded, grained or vignetted. The same module serves three hosts:
//
//   * the WebGL renderer (utils/lut-renderer.js) asks for the layout, so the
//     live preview places the photo inside the frame;
//   * the preview overlay canvas (pages/index) paints the frame decoration on
//     top of the stage;
//   * the full-resolution export (utils/export.js + export-wechat.js) paints
//     the same frame into the assembly canvas before the tiles are blitted.
//
// Everything is expressed in the pixels of the picture, so a layout scales
// linearly with the photo; the painter only uses the common Canvas 2D subset
// (fillRect, paths, arcTo, fillText, measureText, transforms) that the Mini
// Program 2D canvas and an offscreen canvas support. No images, no fonts to
// load, no network.
(function registerBorder(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpektrafilmBorder = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function borderFactory() {
  const NONE = 'none';

  // The styles in the order of the picker. `name` is the label of the card.
  const STYLES = Object.freeze([
    Object.freeze({ id: 'none', name: '无边框' }),
    Object.freeze({ id: 'thin-white', name: '细白边' }),
    Object.freeze({ id: 'polaroid', name: '拍立得' }),
    Object.freeze({ id: 'black', name: '黑边' }),
    Object.freeze({ id: 'film35', name: '35mm 胶片' }),
    Object.freeze({ id: 'film120', name: '120 胶片' }),
    Object.freeze({ id: 'edge-black-thin', name: '不规则细黑边' }),
    Object.freeze({ id: 'edge-black', name: '不规则黑边' }),
    Object.freeze({ id: 'edge-white-thin', name: '不规则细白边' }),
    Object.freeze({ id: 'edge-white', name: '不规则白边' }),
  ]);
  const STYLE_IDS = Object.freeze(STYLES.map((style) => style.id));

  // The irregular film-edge styles: only a narrow band right at the outermost
  // edge of the picture, no outer margin, no print. `lo`/`hi` bound the width
  // of every side as a fraction of the short side of the picture. `rim` is the
  // slightly different tone of the film base outside the wobbly contour that
  // makes the irregularity visible.
  const EDGE_STYLES = Object.freeze({
    'edge-black-thin': Object.freeze({
      color: '#050505', rim: '#2e2d2a', lo: 0.006, hi: 0.012, seed: 21,
    }),
    'edge-black': Object.freeze({
      color: '#050505', rim: '#2e2d2a', lo: 0.015, hi: 0.025, seed: 22,
    }),
    'edge-white-thin': Object.freeze({
      color: '#fcfbf8', rim: '#e2e0d9', lo: 0.006, hi: 0.012, seed: 23,
    }),
    'edge-white': Object.freeze({
      color: '#fcfbf8', rim: '#e2e0d9', lo: 0.015, hi: 0.025, seed: 24,
    }),
  });
  // A thumbnail in the picker would show a 1 % edge as a hairline: it gets at
  // least this much (fraction of the short side).
  const EDGE_THUMBNAIL_MIN = 0.035;
  const COLORS = Object.freeze({
    'thin-white': '#ffffff',
    polaroid: '#f4f1e8',
    black: '#000000',
    film35: '#0c0b0a',
    // The thin black rebate; the white scan margin outside it is painted on top.
    film120: '#050505',
    'edge-black-thin': EDGE_STYLES['edge-black-thin'].color,
    'edge-black': EDGE_STYLES['edge-black'].color,
    'edge-white-thin': EDGE_STYLES['edge-white-thin'].color,
    'edge-white': EDGE_STYLES['edge-white'].color,
  });
  const EDGE_RIM = Object.freeze({
    'edge-black-thin': EDGE_STYLES['edge-black-thin'].rim,
    'edge-black': EDGE_STYLES['edge-black'].rim,
    'edge-white-thin': EDGE_STYLES['edge-white-thin'].rim,
    'edge-white': EDGE_STYLES['edge-white'].rim,
  });
  // Orange-yellow edge imprint of a developed colour negative.
  const EDGE_PRINT_COLOR = '#f2a03a';
  // The sprocket holes let the light table through.
  const SPROCKET_COLOR = '#ece6d6';
  const EDGE_FONT = 'sans-serif';

  // 35 mm film: 36 x 24 mm frame on a 35 mm strip -> a 5.5 mm band on each
  // long side, which is 15.3 % of the long edge of a 3:2 picture.
  const FILM35_BAND = 0.153;
  const FILM35_SIDE = 0.025;
  // KS perforation, relative to the band (mm / 5.5 mm).
  const SPROCKET_LENGTH = 0.36;
  const SPROCKET_ACROSS = 0.51;
  const SPROCKET_PITCH = 0.864;
  const SPROCKET_INSET = 0.17;
  const SPROCKET_RADIUS = 0.08;

  // 120 film, scanned with its rebate ("带片边扫描"): the photo keeps its own
  // aspect ratio and is wrapped by a thin, slightly irregular black film edge,
  // wider on the side that carries the edge print, then a thin white scan
  // margin. Everything is a fraction of the SHORT side of the photo, and the
  // irregularity comes from a fixed seed, so the preview and the export draw
  // the very same frame.
  const FILM120_SEED = 9;
  const FILM120_PRINT_BAND = 0.034;
  const FILM120_MARGIN = 0.016;
  const FILM120_RADIUS = 0.011;
  const FILM120_JITTER = 0.005;
  const FILM120_FRAME_NUMBER = 7;
  // The scanner margin and the printed ink of a black-and-white stock.
  const SCAN_MARGIN_COLOR = '#fcfbf8';
  const MONO_PRINT_COLOR = '#e8e8e2';
  const FILM120_FRINGE = 'rgba(255, 140, 50, 0.55)';
  const FILM120_FRINGE_MONO = 'rgba(255, 255, 255, 0.2)';
  const PRINT_SQUEEZE = 0.8;
  const MONO_NAME = /(tri-?x|hp5|fp4|delta|t-?max|tmax|acros|neopan|plus-?x|pan\s?f|ilford|b\s?&\s?w|\bbw\b|mono|black\s+and\s+white|黑白)/i;

  function normalizeStyle(value) {
    return STYLE_IDS.indexOf(value) === -1 ? NONE : value;
  }

  function styleName(id) {
    const found = STYLES.find((style) => style.id === id);
    return found ? found.name : STYLES[0].name;
  }

  function positive(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number < 1) {
      throw new Error(`Invalid picture dimension: ${value}`);
    }
    return number;
  }

  // Margins are at least one pixel so that a tiny picture still shows a frame.
  function margin(fraction, basis) {
    return Math.max(1, Math.round(fraction * basis));
  }

  // mulberry32: a tiny deterministic generator, so a "random" frame is the same
  // in the preview, in the export and on every device.
  function seededRandom(seed) {
    let state = seed >>> 0;
    return function next() {
      state = (state + 0x6D2B79F5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * The geometry of the 120 film edge for a picture whose short side is
   * `short` pixels. All numbers are floats in picture pixels: the widths of the
   * black rebate per side, the white scan margin per side, and the offsets of
   * the four outer corners of the black strip (so it is not quite parallel to
   * the picture). The print side is the long side of the film strip: left for
   * a portrait or square picture, top for a landscape one.
   */
  function film120Geometry(horizontal, short) {
    const random = seededRandom(FILM120_SEED);
    const r = [];
    for (let index = 0; index < 24; index += 1) {
      r.push(random());
    }
    const wide = FILM120_PRINT_BAND * short;
    const black = horizontal
      ? {
        top: wide * (0.96 + 0.08 * r[0]),
        left: 0.008 * short * (0.8 + 0.5 * r[1]),
        right: 0.0125 * short * (0.8 + 0.5 * r[2]),
        bottom: (0.011 * (0.8 + 0.5 * r[3]) + 0.003) * short,
      }
      : {
        left: wide * (0.96 + 0.08 * r[0]),
        right: 0.012 * short * (0.8 + 0.5 * r[1]),
        top: 0.0075 * short * (0.8 + 0.5 * r[2]),
        bottom: 0.011 * short * (0.8 + 0.5 * r[3]),
      };
    const m0 = FILM120_MARGIN * short;
    const white = {
      left: m0 * (1 + 0.9 * r[4]),
      top: m0 * (0.6 + 0.9 * r[5]),
      right: m0 * (0.5 + 0.7 * r[6]),
      bottom: m0 * (0.9 + r[7]),
    };
    const corners = [];
    for (let index = 0; index < 4; index += 1) {
      corners.push([
        (r[8 + index * 2] - 0.5) * FILM120_JITTER * short,
        (r[9 + index * 2] - 0.5) * FILM120_JITTER * short,
      ]);
    }
    return {
      print: horizontal ? 'top' : 'left',
      wide,
      black,
      white,
      corners,
      radius: FILM120_RADIUS * short,
    };
  }

  /**
   * The frame around a picture of photoW x photoH pixels.
   *
   * Returns the margins (left/top/right/bottom, top-down like Canvas 2D), the
   * outer size, the base colour and, for the film styles, the orientation of
   * the strip and the band/side widths. Style `none` has zero margins, so the
   * outer size is the picture size. Every margin scales linearly with the
   * picture, so the layout of a downscaled preview is the layout of the
   * export divided by one constant.
   */
  function computeLayout(styleId, photoW, photoH) {
    const style = normalizeStyle(styleId);
    const width = positive(photoW);
    const height = positive(photoH);
    const short = Math.min(width, height);
    const long = Math.max(width, height);
    // A 3:2 picture gets the real film proportions; a panorama does not get
    // an absurdly wide band.
    const filmBasis = Math.min(long, short * 1.5);
    const horizontal = width >= height;
    const layout = {
      style,
      photoW: width,
      photoH: height,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      color: COLORS[style] || '#000000',
      orientation: horizontal ? 'horizontal' : 'vertical',
      band: 0,
      side: 0,
    };
    switch (style) {
      case 'thin-white': {
        const edge = margin(0.035, short);
        Object.assign(layout, { left: edge, top: edge, right: edge, bottom: edge });
        break;
      }
      case 'polaroid': {
        const edge = margin(0.06, short);
        Object.assign(layout, {
          left: edge, top: edge, right: edge, bottom: margin(0.22, short),
        });
        break;
      }
      case 'black': {
        const edge = margin(0.04, short);
        Object.assign(layout, { left: edge, top: edge, right: edge, bottom: edge });
        break;
      }
      case 'film35': {
        const band = margin(FILM35_BAND, filmBasis);
        const side = margin(FILM35_SIDE, long);
        layout.band = band;
        layout.side = side;
        // The strip runs along the long edge: bands on the long sides.
        if (horizontal) {
          Object.assign(layout, { left: side, right: side, top: band, bottom: band });
        } else {
          Object.assign(layout, { left: band, right: band, top: side, bottom: side });
        }
        break;
      }
      case 'edge-black-thin':
      case 'edge-black':
      case 'edge-white-thin':
      case 'edge-white': {
        const edge = edgeGeometry(style, short);
        Object.assign(layout, {
          left: margin(1, edge.widths.left),
          top: margin(1, edge.widths.top),
          right: margin(1, edge.widths.right),
          bottom: margin(1, edge.widths.bottom),
          edge,
        });
        break;
      }
      case 'film120': {
        const film = film120Geometry(width > height, short);
        const total = (key) => Math.max(1, Math.round(film.white[key] + film.black[key]));
        Object.assign(layout, {
          left: total('left'),
          top: total('top'),
          right: total('right'),
          bottom: total('bottom'),
          band: Math.round(film.wide),
          film,
        });
        break;
      }
      default:
        break;
    }
    layout.outerW = width + layout.left + layout.right;
    layout.outerH = height + layout.top + layout.bottom;
    return layout;
  }

  /**
   * A frame for the export: the picture is shrunk until the framed picture
   * fits `maxOuterLongEdge`. `fit(photoW, photoH)` must return the smaller
   * picture size to try; the loop converges because the layout is linear.
   * Returns { layout, photoW, photoH }.
   */
  function fitLayout(styleId, photoW, photoH, maxOuterLongEdge, fit) {
    let width = positive(photoW);
    let height = positive(photoH);
    let layout = computeLayout(styleId, width, height);
    const cap = Math.max(1, Math.floor(Number(maxOuterLongEdge) || Infinity));
    for (let guard = 0; guard < 24; guard += 1) {
      const outerLong = Math.max(layout.outerW, layout.outerH);
      if (outerLong <= cap) {
        break;
      }
      const photoLong = Math.max(width, height);
      const ratio = outerLong / photoLong;
      // Aim slightly below the exact solution so that rounding converges.
      const targetLong = Math.max(1, Math.min(photoLong - 1, Math.floor(cap / ratio) - guard));
      const next = fit(width, height, targetLong);
      width = positive(next.width);
      height = positive(next.height);
      layout = computeLayout(styleId, width, height);
    }
    return { layout, photoW: width, photoH: height };
  }

  /**
   * The geometry of an irregular film edge. The band widths differ per side
   * (floats, picture pixels), and every side has its own smooth wobble of the
   * contour that separates the band from the film base outside it: two sine
   * waves with seeded frequency and phase, in units of the side length, so the
   * pattern is the same for any photo size.
   */
  function edgeGeometry(style, short) {
    const spec = EDGE_STYLES[style];
    const random = seededRandom(spec.seed);
    // Four spread-out levels dealt to the sides in a seeded order, so the
    // sides always differ visibly (a plain random draw can come out equal).
    const levels = [0.04, 0.38, 0.68, 1];
    for (let index = levels.length - 1; index > 0; index -= 1) {
      const pick = Math.floor(random() * (index + 1));
      const swap = levels[index];
      levels[index] = levels[pick];
      levels[pick] = swap;
    }
    const width = (level) => (spec.lo + (spec.hi - spec.lo) * level) * short;
    const widths = {
      left: width(levels[0]), top: width(levels[1]), right: width(levels[2]), bottom: width(levels[3]),
    };
    const wobble = {};
    ['left', 'top', 'right', 'bottom'].forEach((side) => {
      wobble[side] = {
        base: 0.36 + 0.12 * random(),
        f1: 1.4 + 1.2 * random(),
        p1: random() * Math.PI * 2,
        f2: 3.6 + 2.2 * random(),
        p2: random() * Math.PI * 2,
      };
    });
    return {
      rim: spec.rim,
      widths,
      wobble,
      radius: Math.min(widths.left, widths.top, widths.right, widths.bottom) * 1.6,
    };
  }

  // The black widths of the 120 edge, clamped so that a tiny picture, whose
  // margins are rounded to whole pixels, keeps a sliver of white scan margin.
  function film120Blacks(layout) {
    const black = layout.film.black;
    return {
      left: Math.min(black.left, layout.left * 0.9),
      top: Math.min(black.top, layout.top * 0.9),
      right: Math.min(black.right, layout.right * 0.9),
      bottom: Math.min(black.bottom, layout.bottom * 0.9),
    };
  }

  // The width of the white scan margin on one side of the picture.
  function film120Edge(layout, side) {
    return layout[side] - film120Blacks(layout)[side];
  }

  // Is this stock a black-and-white one? Its edge print is light, not amber.
  function isMonochrome(stockName) {
    return MONO_NAME.test(String(stockName || ''));
  }

  /**
   * CSS-free miniature of a style for the picker: the frame boxes as
   * fractions (0..1) of a sample picture's outer size.
   */
  function thumbnailGeometry(styleId, sampleW, sampleH) {
    const layout = computeLayout(styleId, sampleW || 300, sampleH || 200);
    if (layout.edge) {
      // The edge of these styles is far too thin to read in a card.
      const least = EDGE_THUMBNAIL_MIN * Math.min(layout.photoW, layout.photoH);
      ['left', 'top', 'right', 'bottom'].forEach((side) => {
        layout[side] = Math.max(layout[side], least);
      });
      layout.outerW = layout.photoW + layout.left + layout.right;
      layout.outerH = layout.photoH + layout.top + layout.bottom;
    }
    return {
      style: layout.style,
      aspect: layout.outerW / layout.outerH,
      left: layout.left / layout.outerW,
      right: layout.right / layout.outerW,
      top: layout.top / layout.outerH,
      bottom: layout.bottom / layout.outerH,
      color: layout.color,
      orientation: layout.orientation,
      // Styles with a second colour (the 120 film edge: black rebate inside a
      // white scan margin) describe it as the box of the inner colour.
      outerColor: layout.film ? SCAN_MARGIN_COLOR : '',
      ring: layout.film ? {
        left: film120Edge(layout, 'left') / layout.outerW,
        right: film120Edge(layout, 'right') / layout.outerW,
        top: film120Edge(layout, 'top') / layout.outerH,
        bottom: film120Edge(layout, 'bottom') / layout.outerH,
      } : null,
    };
  }

  // --- painting --------------------------------------------------------------

  function fillFrame(ctx, layout) {
    const {
      left, top, right, bottom, outerW, outerH, photoW, photoH,
    } = layout;
    ctx.fillStyle = layout.color;
    // Four rectangles: the photo area is never painted, so the same call can
    // draw an overlay above a live picture or a frame below the tiles.
    ctx.fillRect(0, 0, outerW, top);
    ctx.fillRect(0, outerH - bottom, outerW, bottom);
    ctx.fillRect(0, top, left, photoH);
    ctx.fillRect(outerW - right, top, right, photoH);
    return photoW;
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.arcTo(x + width, y, x + width, y + r, r);
    ctx.lineTo(x + width, y + height - r);
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
    ctx.lineTo(x + r, y + height);
    ctx.arcTo(x, y + height, x, y + height - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // A small right-pointing triangle, the film's frame arrow.
  function drawArrow(ctx, x, centerY, size) {
    ctx.beginPath();
    ctx.moveTo(x, centerY - size / 2);
    ctx.lineTo(x + size * 0.9, centerY);
    ctx.lineTo(x, centerY + size / 2);
    ctx.closePath();
    ctx.fill();
  }

  function fitFontSize(ctx, text, size, maxWidth) {
    ctx.font = `bold ${size}px ${EDGE_FONT}`;
    const width = ctx.measureText(text).width;
    if (width > maxWidth && width > 0) {
      return Math.max(1, size * (maxWidth / width));
    }
    return size;
  }

  /**
   * The edge imprint of one band. `centerY` is the vertical centre of the
   * text row in strip coordinates. `kind` 'top' carries the stock name and a
   * frame arrow, 'bottom' the frame numbers.
   */
  function drawEdgePrint(ctx, geometry, kind, centerY, fontSize, options) {
    const text = options.stockName ? String(options.stockName).toUpperCase() : '';
    const number = String(options.frameNumber === undefined ? 12 : options.frameNumber);
    const x0 = geometry.side + geometry.photoLength * 0.03;
    const x1 = geometry.side + geometry.photoLength * 0.97;
    ctx.fillStyle = EDGE_PRINT_COLOR;
    ctx.textBaseline = 'middle';
    const arrow = fontSize * 0.8;
    if (kind === 'top') {
      if (text) {
        const size = fitFontSize(ctx, text, fontSize, geometry.photoLength * 0.62);
        ctx.font = `bold ${size}px ${EDGE_FONT}`;
        ctx.textAlign = 'left';
        ctx.fillText(text, x0, centerY);
      }
      drawArrow(ctx, x1 - arrow * 0.9, centerY, arrow);
    } else {
      ctx.font = `bold ${fontSize}px ${EDGE_FONT}`;
      drawArrow(ctx, x0, centerY, arrow);
      ctx.textAlign = 'left';
      ctx.fillText(number, x0 + arrow * 1.7, centerY);
      ctx.textAlign = 'right';
      ctx.fillText(`${number}A`, x1, centerY);
    }
  }

  // Strip coordinates: x runs along the strip, y across it, the picture sits
  // at x in [side, length - side] and y in [band, across - band]. A portrait
  // picture rotates the strip a quarter turn.
  function withStrip(ctx, layout, paint) {
    const horizontal = layout.orientation === 'horizontal';
    const geometry = {
      length: horizontal ? layout.outerW : layout.outerH,
      across: horizontal ? layout.outerH : layout.outerW,
      band: layout.band,
      side: layout.side,
      photoLength: horizontal ? layout.photoW : layout.photoH,
    };
    ctx.save();
    if (!horizontal) {
      ctx.translate(layout.outerW, 0);
      ctx.rotate(Math.PI / 2);
    }
    try {
      paint(geometry);
    } finally {
      ctx.restore();
    }
  }

  function drawFilm35(ctx, layout, options) {
    withStrip(ctx, layout, (geometry) => {
      const band = geometry.band;
      const holeLength = band * SPROCKET_LENGTH;
      const holeAcross = band * SPROCKET_ACROSS;
      const pitch = band * SPROCKET_PITCH;
      const count = Math.max(1, Math.floor((geometry.length - holeLength) / pitch) + 1);
      const offset = (geometry.length - ((count - 1) * pitch + holeLength)) / 2;
      const inset = band * SPROCKET_INSET;
      ctx.fillStyle = SPROCKET_COLOR;
      for (let index = 0; index < count; index += 1) {
        const x = offset + index * pitch;
        roundedRect(ctx, x, inset, holeLength, holeAcross, band * SPROCKET_RADIUS);
        ctx.fill();
        roundedRect(
          ctx, x, geometry.across - inset - holeAcross, holeLength, holeAcross,
          band * SPROCKET_RADIUS
        );
        ctx.fill();
      }
      const fontSize = band * 0.19;
      drawEdgePrint(ctx, geometry, 'top', band * 0.84, fontSize, options);
      drawEdgePrint(ctx, geometry, 'bottom', geometry.across - band * 0.84, fontSize, options);
    });
  }

  // A rounded polygon through four points, each corner with its own radius.
  // The points run around the shape; arcTo rounds the corner at the first
  // point of every call.
  function roundedQuad(ctx, points, radii) {
    const count = points.length;
    const mid = [
      (points[0][0] + points[1][0]) / 2,
      (points[0][1] + points[1][1]) / 2,
    ];
    ctx.moveTo(mid[0], mid[1]);
    for (let index = 1; index <= count; index += 1) {
      const corner = points[index % count];
      const next = points[(index + 1) % count];
      ctx.arcTo(corner[0], corner[1], next[0], next[1], radii[index % count]);
    }
    ctx.closePath();
  }

  // A thin slanted sliver along an edge of the black strip: the orange light
  // bleed at the film edge. `from`/`to` are along the edge, `inward` is the
  // unit step into the black.
  function fringe(ctx, a, b, inward, thickness) {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(b[0] + inward[0] * thickness, b[1] + inward[1] * thickness);
    ctx.lineTo(a[0] + inward[0] * thickness, a[1] + inward[1] * thickness);
    ctx.closePath();
    ctx.fill();
  }

  function lerp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // The print of one 120 film: the stock name, the frame arrow with its number
  // and the half-frame number, in a condensed look (the Mini Program canvas
  // has no condensed font, so a bold sans is squeezed horizontally). It runs
  // along the wide black band: left to right on top of a landscape picture,
  // bottom to top on the left of a portrait one.
  function drawFilm120Print(ctx, layout, blacks, options) {
    const film = layout.film;
    const vertical = film.print === 'left';
    const length = vertical ? layout.photoH : layout.photoW;
    const fontSize = film.wide * 0.5;
    const number = String(options.frameNumber === undefined ? FILM120_FRAME_NUMBER : options.frameNumber);
    const mono = options.monochrome === undefined ? isMonochrome(options.stockName) : !!options.monochrome;
    const text = options.stockName ? String(options.stockName).toUpperCase() : '';
    ctx.save();
    try {
      ctx.fillStyle = mono ? MONO_PRINT_COLOR : EDGE_PRINT_COLOR;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      // The origin of the print: the centre of the band, at the start of the
      // strip direction.
      if (vertical) {
        ctx.translate(layout.left - blacks.left / 2, layout.top + layout.photoH);
        ctx.rotate(-Math.PI / 2);
      } else {
        ctx.translate(layout.left, layout.top - blacks.top / 2);
      }
      ctx.scale(PRINT_SQUEEZE, 1);
      // From here on x runs along the strip in squeezed units.
      const unit = (fraction) => (fraction * length) / PRINT_SQUEEZE;
      const arrow = fontSize * 0.8;
      if (text) {
        ctx.font = `bold ${fontSize}px ${EDGE_FONT}`;
        const room = (length * 0.42) / PRINT_SQUEEZE;
        const width = ctx.measureText(text).width;
        const size = width > room && width > 0 ? Math.max(1, fontSize * (room / width)) : fontSize;
        ctx.font = `bold ${size}px ${EDGE_FONT}`;
        ctx.fillText(text, unit(0.07), 0);
      }
      ctx.font = `bold ${fontSize}px ${EDGE_FONT}`;
      drawArrow(ctx, unit(0.52), 0, arrow);
      ctx.fillText(number, unit(0.52) + arrow * 1.6, 0);
      ctx.fillText(`${number}A`, unit(0.86), 0);
    } finally {
      ctx.restore();
    }
  }

  function drawFilm120(ctx, layout, options) {
    const film = layout.film;
    const blacks = film120Blacks(layout);
    const right = layout.left + layout.photoW;
    const bottom = layout.top + layout.photoH;
    // Outer corners of the black strip, each nudged a little (a film that sits
    // slightly crooked in its holder), clockwise from the top left.
    const corners = [
      [layout.left - blacks.left, layout.top - blacks.top],
      [right + blacks.right, layout.top - blacks.top],
      [right + blacks.right, bottom + blacks.bottom],
      [layout.left - blacks.left, bottom + blacks.bottom],
    ].map((point, index) => [point[0] + film.corners[index][0], point[1] + film.corners[index][1]]);
    // The outer corners are rounded, but never so much that the corner of the
    // picture itself would fall outside the strip.
    const radii = corners.map((corner, index) => {
      const dx = index === 0 || index === 3 ? blacks.left : blacks.right;
      const dy = index < 2 ? blacks.top : blacks.bottom;
      return Math.max(0.5, Math.min(film.radius, dx * 0.9, dy * 0.9));
    });
    // The white scan margin: the frame rectangle with the black strip cut out
    // (the strip runs the other way round, so it is a hole under the non-zero
    // rule). The picture lies inside the strip and is never touched.
    ctx.fillStyle = SCAN_MARGIN_COLOR;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(layout.outerW, 0);
    ctx.lineTo(layout.outerW, layout.outerH);
    ctx.lineTo(0, layout.outerH);
    ctx.closePath();
    const reversed = [corners[0], corners[3], corners[2], corners[1]];
    roundedQuad(ctx, reversed, [radii[0], radii[3], radii[2], radii[1]]);
    ctx.fill();
    // The orange fringe along the outer edge of the black strip.
    const mono = options.monochrome === undefined ? isMonochrome(options.stockName) : !!options.monochrome;
    ctx.fillStyle = mono ? FILM120_FRINGE_MONO : FILM120_FRINGE;
    const thickness = Math.max(1, Math.min(layout.photoW, layout.photoH) * 0.0016);
    const topEdge = (from, to) => fringe(
      ctx, lerp(corners[0], corners[1], from), lerp(corners[0], corners[1], to), [0, 1], thickness
    );
    const leftEdge = (from, to) => fringe(
      ctx, lerp(corners[0], corners[3], from), lerp(corners[0], corners[3], to), [1, 0], thickness
    );
    topEdge(0.06, 0.38);
    topEdge(0.52, 0.6);
    leftEdge(0.1, 0.27);
    drawFilm120Print(ctx, layout, blacks, options);
  }

  // A wobble in [-1, 1] along one side, 0 at both ends so that the contour
  // meets the rounded corners tangentially.
  function wobbleAt(spec, fraction) {
    const wave = 0.62 * Math.sin(Math.PI * 2 * spec.f1 * fraction + spec.p1) +
      0.38 * Math.sin(Math.PI * 2 * spec.f2 * fraction + spec.p2);
    const edge = Math.min(1, fraction / 0.12, (1 - fraction) / 0.12);
    const taper = edge * edge * (3 - 2 * edge);
    return wave * taper;
  }

  /**
   * The irregular film edge. The whole margin is the band colour (four
   * rectangles, like the plain styles). A contour inside the band, wobbling
   * slightly per side and softly rounded at the corners, separates the band
   * from the film base outside it, which is painted in a slightly different
   * tone. The contour never gets near the picture (it stays in the outer
   * 24-60 % of every side), so no photo pixel is touched.
   */
  function drawEdge(ctx, layout) {
    const edge = layout.edge;
    const amplitude = 0.32;
    const steps = 64;
    const insets = {};
    ['left', 'top', 'right', 'bottom'].forEach((side) => {
      insets[side] = layout[side] * edge.wobble[side].base;
    });
    const x0 = insets.left;
    const x1 = layout.outerW - insets.right;
    const y0 = insets.top;
    const y1 = layout.outerH - insets.bottom;
    const radius = Math.max(0.5, Math.min(edge.radius, (x1 - x0) / 4, (y1 - y0) / 4));
    const offset = (side, fraction) => insets[side] *
      (1 + amplitude * wobbleAt(edge.wobble[side], fraction));
    ctx.fillStyle = edge.rim;
    ctx.beginPath();
    // The frame rectangle, counter-clockwise ...
    ctx.moveTo(0, 0);
    ctx.lineTo(0, layout.outerH);
    ctx.lineTo(layout.outerW, layout.outerH);
    ctx.lineTo(layout.outerW, 0);
    ctx.closePath();
    // ... and the contour, clockwise, which cuts a hole in it.
    ctx.moveTo(x0 + radius, offset('top', 0));
    for (let index = 1; index <= steps; index += 1) {
      const fraction = index / steps;
      ctx.lineTo(x0 + radius + fraction * (x1 - x0 - 2 * radius), offset('top', fraction));
    }
    ctx.arcTo(x1, y0, x1, y0 + radius, radius);
    for (let index = 1; index <= steps; index += 1) {
      const fraction = index / steps;
      ctx.lineTo(
        layout.outerW - offset('right', fraction),
        y0 + radius + fraction * (y1 - y0 - 2 * radius)
      );
    }
    ctx.arcTo(x1, y1, x1 - radius, y1, radius);
    for (let index = 1; index <= steps; index += 1) {
      const fraction = index / steps;
      ctx.lineTo(
        x1 - radius - fraction * (x1 - x0 - 2 * radius),
        layout.outerH - offset('bottom', fraction)
      );
    }
    ctx.arcTo(x0, y1, x0, y1 - radius, radius);
    for (let index = 1; index <= steps; index += 1) {
      const fraction = index / steps;
      ctx.lineTo(
        offset('left', fraction),
        y1 - radius - fraction * (y1 - y0 - 2 * radius)
      );
    }
    ctx.arcTo(x0, y0, x0 + radius, y0, radius);
    ctx.closePath();
    ctx.fill();
  }

  function drawPolaroidEdge(ctx, layout) {
    // A hairline where the print meets the paper.
    const width = Math.max(1, Math.round(Math.min(layout.photoW, layout.photoH) * 0.0015));
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.lineWidth = width;
    ctx.strokeRect(
      layout.left - width / 2,
      layout.top - width / 2,
      layout.photoW + width,
      layout.photoH + width
    );
  }

  /**
   * Paint the frame of `layout` into a 2D context whose origin is the top-left
   * corner of the OUTER picture and whose unit is one picture pixel (scale the
   * context for a smaller preview). The photo rectangle is left untouched.
   *
   * options.stockName: the preset name printed on the film edge.
   * options.frameNumber: the printed frame number (default 12; 7 on 120 film).
   * options.monochrome: print the 120 edge in light grey (default: guessed
   * from the stock name).
   */
  function drawBorder(ctx, layout, options) {
    if (!layout || layout.style === NONE) {
      return;
    }
    const settings = options || {};
    ctx.save();
    try {
      fillFrame(ctx, layout);
      if (layout.style === 'film35') {
        drawFilm35(ctx, layout, settings);
      } else if (layout.style === 'film120') {
        drawFilm120(ctx, layout, settings);
      } else if (layout.edge) {
        drawEdge(ctx, layout);
      } else if (layout.style === 'polaroid') {
        drawPolaroidEdge(ctx, layout);
      }
    } finally {
      ctx.restore();
    }
  }

  return {
    NONE,
    STYLES,
    STYLE_IDS,
    COLORS,
    EDGE_RIM,
    EDGE_PRINT_COLOR,
    SPROCKET_COLOR,
    SCAN_MARGIN_COLOR,
    MONO_PRINT_COLOR,
    isMonochrome,
    normalizeStyle,
    styleName,
    computeLayout,
    fitLayout,
    thumbnailGeometry,
    drawBorder,
  };
}));
