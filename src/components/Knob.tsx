/** The mockup's arc knob. `f` is 0..1, or -1..1 when `bipolar` (centred). */
export function Knob({ f, bipolar = false, size = 20 }: { f: number; bipolar?: boolean; size?: number }) {
  const r = size * 0.38;
  const c = size / 2;
  const sw = size > 24 ? 2.4 : 2;
  const P = (deg: number, k = 1) => {
    const a = (deg * Math.PI) / 180;
    return [(c + r * k * Math.sin(a)).toFixed(2), (c - r * k * Math.cos(a)).toFixed(2)];
  };
  const arc = (a0: number, a1: number) => {
    const p0 = P(a0);
    const p1 = P(a1);
    return `M${p0[0]} ${p0[1]}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${p1[0]} ${p1[1]}`;
  };
  const v = Math.min(Math.max(f, bipolar ? -1 : 0), 1);
  const a = bipolar ? v * 135 : -135 + v * 270;
  const a0 = bipolar ? 0 : -135;
  const n0 = P(a, 0.2);
  const n1 = P(a, 1);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <path d={arc(-135, 135)} fill="none" stroke="var(--knob-track)" strokeWidth={sw} />
      {Math.abs(a - a0) > 0.5 && <path d={arc(Math.min(a0, a), Math.max(a0, a))} fill="none" stroke="var(--knob)" strokeWidth={sw} />}
      <line x1={n0[0]} y1={n0[1]} x2={n1[0]} y2={n1[1]} stroke="var(--knob)" strokeWidth={sw} strokeLinecap="round" />
    </svg>
  );
}
