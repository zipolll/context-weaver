import { BaseEdge, type EdgeProps } from '@xyflow/react';

// Both endpoints remain at the handles' centers. The chevron sits in the free
// segment, so small dots cannot cover it or appear to have an off-center handle.
export function DirectedEdge({ id, sourceX, sourceY, targetX, targetY, style, data }: EdgeProps) {
  const dx = targetX - sourceX, dy = targetY - sourceY, distance = Math.hypot(dx, dy);
  const start = Number(data?.sourceRadius ?? 7) + 4, end = distance - Number(data?.targetRadius ?? 7) - 4;
  const ux = dx / (distance || 1), uy = dy / (distance || 1), at = start + (end - start) * 2 / 3;
  const x = sourceX + ux * at, y = sourceY + uy * at;
  return <>
    <BaseEdge id={id} path={`M ${sourceX},${sourceY} L ${targetX},${targetY}`} style={style} interactionWidth={0} />
    {end - start > 16 && <path className="provenance-arrow" d={`M ${x - ux * 5.5 - uy * 3},${y - uy * 5.5 + ux * 3} L ${x},${y} L ${x - ux * 5.5 + uy * 3},${y - uy * 5.5 - ux * 3}`}
      fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ ...style, fill: 'none', pointerEvents: 'none' }} aria-hidden="true" />}
  </>;
}
