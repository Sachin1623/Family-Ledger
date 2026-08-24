import React from 'react';

// Pip layouts for a classic die face, on a 3x3 grid.
const DICE_PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [0, 2], [2, 0], [2, 2]],
  5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
  6: [[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2]],
};

// Where a pip lands within a face's local 0-1 (u,v) grid — same 3-position spacing DICE_PIPS'
// row/col indices already assume, just as fractions instead of grid cells.
const PIP_UV = [0.22, 0.5, 0.78];

interface FaceGeom { origin: [number, number]; uVec: [number, number]; vVec: [number, number]; fill: string; }
// Isometric cube geometry in a 0-100 viewBox: each face is a parallelogram described by one
// corner (`origin`) plus the two edge vectors reaching its other corners — bilinear-interpolating
// within that gives any pip's exact (x,y), reusing DICE_PIPS' existing row/col patterns rather
// than needing a separate hand-placed layout per face. Matches a reference isometric-die icon's
// silhouette (the polygon points in the component below are that same hexagonal cube outline),
// white body / black pips — top face lightest, the two side faces shaded slightly darker for depth.
const TOP_FACE: FaceGeom = { origin: [50, 4], uVec: [42, 24], vVec: [-42, 24], fill: '#ffffff' };
const RIGHT_FACE: FaceGeom = { origin: [92, 28], uVec: [0, 46], vVec: [-42, 24], fill: '#e7e9ee' };
const LEFT_FACE: FaceGeom = { origin: [8, 28], uVec: [0, 46], vVec: [42, 24], fill: '#d2d6dc' };

function facePipXY(face: FaceGeom, row: number, col: number): [number, number] {
  const u = PIP_UV[col];
  const v = PIP_UV[row];
  return [face.origin[0] + u * face.uVec[0] + v * face.vVec[0], face.origin[1] + u * face.uVec[1] + v * face.vVec[1]];
}

const FacePips: React.FC<{ face: FaceGeom; pips: [number, number][] }> = ({ face, pips }) => (
  <>
    {pips.map(([r, c], i) => {
      const [x, y] = facePipXY(face, r, c);
      return <ellipse key={i} cx={x} cy={y} rx={5.5} ry={4.2} fill="#15171c" />;
    })}
  </>
);

// A real isometric 3D cube (3 visible faces drawn in true perspective) instead of one flat face —
// shared by every game in the app that rolls dice (Ludo, Business, …), so the look and the roll
// animation stay identical everywhere rather than drifting per-screen. Only the top face shows
// the ACTUAL rolled value; the two side faces show fixed decorative pip counts purely for visual
// fullness (a real die would show whatever its geometry dictates there, but nothing in this app's
// rules depends on those two faces, so they're just set-dressing). Because the 3D illusion is
// baked into the artwork itself, spinning the whole icon with a plain 2D rotate() reads as a
// convincing tumble — unlike an earlier flat-face version this replaced, there's no single face
// to go edge-on/mirrored partway through, since the drawing always shows a full cube regardless
// of rotation angle. Deliberately has no onClick/color props — every caller now triggers a roll
// via its own separate "Roll" button (tinted to whoever's turn it is) rather than tapping the die
// itself, and the die stays a neutral plain white/gray regardless of whose turn it is.
const DiceFace: React.FC<{ value: number | null; size?: number; spinning?: boolean }> = ({ value, size = 48, spinning }) => {
  const topPips = value != null ? DICE_PIPS[value] || [] : [];
  return (
    <div>
      <style>{`@keyframes sharedDice3DRoll {
        0%   { transform: rotate(0deg)   scale(1); }
        15%  { transform: rotate(150deg) scale(1.08); }
        35%  { transform: rotate(320deg) scale(0.95); }
        55%  { transform: rotate(500deg) scale(1.05); }
        75%  { transform: rotate(640deg) scale(0.98); }
        90%  { transform: rotate(710deg) scale(1.02); }
        100% { transform: rotate(720deg) scale(1); }
      }`}</style>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        className="shrink-0"
        style={{
          filter: 'drop-shadow(0 3px 4px rgba(0,0,0,0.3))',
          animation: spinning ? 'sharedDice3DRoll 0.9s cubic-bezier(0.33, 0, 0.2, 1)' : undefined,
        }}
      >
        <polygon points="50,4 92,28 50,52 8,28" fill={TOP_FACE.fill} stroke="#00000030" strokeWidth="1" strokeLinejoin="round" />
        <polygon points="50,52 92,28 92,74 50,98" fill={RIGHT_FACE.fill} stroke="#00000030" strokeWidth="1" strokeLinejoin="round" />
        <polygon points="50,52 8,28 8,74 50,98" fill={LEFT_FACE.fill} stroke="#00000030" strokeWidth="1" strokeLinejoin="round" />
        <FacePips face={TOP_FACE} pips={topPips} />
        <FacePips face={RIGHT_FACE} pips={DICE_PIPS[3]} />
        <FacePips face={LEFT_FACE} pips={DICE_PIPS[2]} />
      </svg>
    </div>
  );
};

export default DiceFace;
