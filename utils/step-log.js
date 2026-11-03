// The export step log.
//
// Every step of the export (start, end, elapsed, result) is written to the
// console and to this bounded ring buffer, so that the on-device diagnostics
// panel can show what happened without a debugger. The module is pure: the
// Mini Program page and the Node unit suite share one implementation.
(function registerStepLog(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpektrafilmStepLog = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function stepLogFactory() {
  const PREFIX = '[wx-spektrafilm][export]';
  const DEFAULT_LIMIT = 160;
  const MAX_DETAIL = 240;

  // The phases of one step.
  const PHASES = Object.freeze({
    START: 'start',
    OK: 'ok',
    ERROR: 'error',
    TIMEOUT: 'timeout',
    CANCELLED: 'cancelled',
    INFO: 'info',
  });

  function isPlainObject(value) {
    return !!value && typeof value === 'object';
  }

  // The detail of a step is a short, printable string: the raw WeChat
  // payloads are objects, so they are serialised (and truncated).
  function detailText(detail) {
    if (detail === undefined || detail === null || detail === '') {
      return '';
    }
    let text;
    if (typeof detail === 'string') {
      text = detail;
    } else if (isPlainObject(detail) || Array.isArray(detail)) {
      try {
        text = JSON.stringify(detail);
      } catch (error) {
        text = String(detail);
      }
    } else {
      text = String(detail);
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
  }

  function formatEntry(entry) {
    const value = entry || {};
    const elapsed = Number.isFinite(Number(value.elapsed)) && value.elapsed !== null
      ? `${Math.round(Number(value.elapsed))}ms`
      : '';
    const parts = [String(value.step || '-'), String(value.phase || '-')];
    if (elapsed) {
      parts.push(elapsed);
    }
    const detail = detailText(value.detail);
    if (detail) {
      parts.push(detail);
    }
    return parts.join(' ');
  }

  /**
   * A bounded ring buffer of the export steps.
   *
   * The oldest entry is dropped when the buffer is full, so a long export
   * cannot eat the memory of the page.
   */
  function createStepLog(limit) {
    const max = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.floor(Number(limit))
      : DEFAULT_LIMIT;
    const entries = [];
    return {
      limit: max,
      push(entry) {
        const value = entry || {};
        entries.push(value);
        while (entries.length > max) {
          entries.shift();
        }
        return value;
      },
      entries() {
        return entries.slice();
      },
      text() {
        return entries.map(formatEntry).join('\n');
      },
      clear() {
        entries.length = 0;
      },
    };
  }

  return {
    PREFIX,
    PHASES,
    DEFAULT_LIMIT,
    detailText,
    formatEntry,
    createStepLog,
  };
}));
