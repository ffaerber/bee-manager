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
  value, min, max, step = 1, disabled, format, onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** Renders the live value and the two end labels. */
  format: (v: number) => string;
  onCommit: (v: number) => void;
}) {
  const [shown, setShown] = useState(value);
  const [dragging, setDragging] = useState(false);

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
        <input
          type="range"
          min={min} max={max} step={step} value={shown} disabled={disabled}
          onChange={(e) => { setDragging(true); setShown(Number(e.target.value)); }}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          style={{ flex: 1 }}
        />
        <span className="mono" style={{ minWidth: 82, textAlign: 'right', fontWeight: 600 }}>
          {format(shown)}
        </span>
      </div>
      <div className="row spread muted" style={{ fontSize: 11 }}>
        <span>{format(min)}</span><span>{format(max)}</span>
      </div>
    </div>
  );
}

/** Capacity at a given depth, for labelling a depth slider. */
export function depthCapacity(depth: number): string {
  const bytes = Math.pow(2, depth) * 4096;
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log10(bytes) / 3), u.length - 1);
  const v = bytes / Math.pow(1000, i);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
