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
    Object.freeze({ id: 'film120', name: '中画幅' }),
  ]);
  const STYLE_IDS = Object.freeze(STYLES.map((style) => style.id));

  const COLORS = Object.freeze({
    'thin-white': '#ffffff',
    polaroid: '#f4f1e8',
    black: '#000000',
    film35: '#0c0b0a',
    film120: '#0a0a0a',
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
  const FILM120_BAND = 0.07;
  const FILM120_SIDE = 0.04;

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
      case 'film35':
      case 'film120': {
        const band = margin(style === 'film35' ? FILM35_BAND : FILM120_BAND, filmBasis);
        const side = margin(style === 'film35' ? FILM35_SIDE : FILM120_SIDE, long);
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
   * CSS-free miniature of a style for the picker: the frame boxes as
   * fractions (0..1) of a sample picture's outer size.
   */
  function thumbnailGeometry(styleId, sampleW, sampleH) {
    const layout = computeLayout(styleId, sampleW || 300, sampleH || 200);
    return {
      style: layout.style,
      aspect: layout.outerW / layout.outerH,
      left: layout.left / layout.outerW,
      right: layout.right / layout.outerW,
      top: layout.top / layout.outerH,
      bottom: layout.bottom / layout.outerH,
      color: layout.color,
      orientation: layout.orientation,
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

  function drawFilm120(ctx, layout, options) {
    withStrip(ctx, layout, (geometry) => {
      const band = geometry.band;
      const fontSize = band * 0.34;
      drawEdgePrint(ctx, geometry, 'top', band * 0.5, fontSize, options);
      drawEdgePrint(ctx, geometry, 'bottom', geometry.across - band * 0.5, fontSize, options);
    });
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
   * options.frameNumber: the printed frame number (default 12).
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
    EDGE_PRINT_COLOR,
    SPROCKET_COLOR,
    normalizeStyle,
    styleName,
    computeLayout,
    fitLayout,
    thumbnailGeometry,
    drawBorder,
  };
}));
