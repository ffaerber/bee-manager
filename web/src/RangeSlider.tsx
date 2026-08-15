/**
 * A bounded value on a slider.
 *
 * Used wherever a setting has real limits, because the range is context a
 * number field cannot give: seeing that 90% sits near the top of 10–100, or
 * that depth 22 is a third of the way along 17–41, is most of what you need to
 * decide whether to move it.
 *
 * Commits on RELEASE, not on input. Dragging fires continuously, and each event
 * here would be a PATCH, a poll-affecting config change and a row in the
 * actions ledger.
 */

import { useEffect, useState } from 'react';

export function RangeSlider({
  value, min, max, step = 1, stops, disabled, format, onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  /**
   * Snap to these values instead of a continuous range.
   *
   * For a duration, the useful settings are a month, a quarter, half a year, a
   * year — not 187 days. A continuous slider makes those exact values fiddly to
   * hit and every other position meaningless. The current value is folded in if
   * it is not already a stop, so a figure set through the API is still
   * representable rather than being silently snapped away.
   */
  stops?: number[];
  disabled?: boolean;
  /** Renders the live value and the two end labels. */
  format: (v: number) => string;
  onCommit: (v: number) => void;
}) {
  const [shown, setShown] = useState(value);
  const [dragging, setDragging] = useState(false);

  const scale = stops
    ? Array.from(new Set([...stops, value])).sort((a, b) => a - b)
    : null;

  // Follow the server once a save lands, but never mid-drag — otherwise a
  // refresh arriving between grab and release yanks the handle back.
  useEffect(() => { if (!dragging) setShown(value); }, [value, dragging]);

  const commit = () => {
    setDragging(false);
    if (shown !== value) onCommit(shown);
  };

  return (
    <div>
      <div className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'center' }}>
        {scale ? (
          // The slider runs over indices; the value is looked up. That is what
          // makes the stops snap rather than merely suggest.
          <input
            type="range"
            min={0} max={scale.length - 1} step={1}
            value={Math.max(0, scale.indexOf(shown))}
            disabled={disabled}
            onChange={(e) => { setDragging(true); setShown(scale[Number(e.target.value)]!); }}
            onMouseUp={commit} onTouchEnd={commit} onKeyUp={commit}
            style={{ flex: 1 }}
          />
        ) : (
          <input
            type="range"
            min={min} max={max} step={step} value={shown} disabled={disabled}
            onChange={(e) => { setDragging(true); setShown(Number(e.target.value)); }}
            onMouseUp={commit}
            onTouchEnd={commit}
            onKeyUp={commit}
            style={{ flex: 1 }}
          />
        )}
        <span className="mono" style={{ minWidth: 82, textAlign: 'right', fontWeight: 600 }}>
          {format(shown)}
        </span>
      </div>
      <div className="row spread muted" style={{ fontSize: 11 }}>
        <span>{format(scale ? scale[0]! : min)}</span>
        <span>{format(scale ? scale[scale.length - 1]! : max)}</span>
      </div>
    </div>
  );
}
