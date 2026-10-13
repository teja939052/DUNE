import type { MindMap, MindMapNode } from '@/api';

/**
 * Renders a lesson concept map from structured nodes and edges.
 *
 * The layout is a hub: the current skill sits in the middle, its prerequisites
 * branch out to the left, and the skills it leads to branch out to the right.
 * Nodes and edges both come from the server-provided payload, so the map always
 * reflects real prerequisite relationships rather than decoration.
 */

const NODE_W: Record<MindMapNode['type'], number> = {
  current: 196,
  prerequisite: 152,
  target: 152,
  remediation: 152,
};

const NODE_H: Record<MindMapNode['type'], number> = {
  current: 62,
  prerequisite: 48,
  target: 48,
  remediation: 48,
};

const COLORS: Record<MindMapNode['type'], { fill: string; stroke: string; text: string; ring: string }> = {
  current: { fill: '#EEF2FF', stroke: '#4F46E5', text: '#312E81', ring: '#C7D2FE' },
  prerequisite: { fill: '#F8FAFC', stroke: '#94A3B8', text: '#334155', ring: '#E2E8F0' },
  target: { fill: '#ECFDF5', stroke: '#10B981', text: '#065F46', ring: '#A7F3D0' },
  remediation: { fill: '#FFFBEB', stroke: '#F59E0B', text: '#92400E', ring: '#FDE68A' },
};

/** Wrap a short label into at most two lines. */
function wrap(label: string, maxChars = 18, maxLines = 2) {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
    } else if ((line + ' ' + word).length <= maxChars) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines;
}

interface PlacedNode {
  node: MindMapNode;
  cx: number;
  cy: number;
  w: number;
  h: number;
  left: number;
  right: number;
}

export interface MindMapDiagramProps {
  mindMap: MindMap;
  /** The concept id to treat as "current". */
  currentId?: string;
  height?: number;
}

export function MindMapDiagram({ mindMap, currentId, height = 340 }: MindMapDiagramProps) {
  const nodes = mindMap.nodes;
  const current =
    nodes.find((n) => n.id === currentId) ||
    nodes.find((n) => n.type === 'current') ||
    nodes[0];

  if (!current) {
    return (
      <div className="rounded-xl bg-gray-50 border border-gray-200 p-6 text-center text-sm text-gray-500">
        No concept map available for this lesson.
      </div>
    );
  }

  const prerequisites = nodes.filter((n) => n.id !== current.id && n.type !== 'target');
  const targets = nodes.filter((n) => n.id !== current.id && n.type === 'target');

  const WIDTH = 1000;
  const CENTER_X = WIDTH / 2;
  const CENTER_Y = height / 2;
  const SPREAD = 96;

  const currentBox: PlacedNode = {
    node: current,
    cx: CENTER_X,
    cy: CENTER_Y,
    w: NODE_W[current.type],
    h: NODE_H[current.type],
    left: CENTER_X - NODE_W[current.type] / 2,
    right: CENTER_X + NODE_W[current.type] / 2,
  };

  const placeColumn = (list: MindMapNode[], side: 'left' | 'right'): PlacedNode[] =>
    list.slice(0, 3).map((n, i) => {
      const count = Math.min(list.length, 3);
      const offset = (i - (count - 1) / 2) * SPREAD;
      const w = NODE_W[n.type];
      const h = NODE_H[n.type];
      const cx = side === 'left' ? 118 : WIDTH - 118;
      return { node: n, cx, cy: CENTER_Y + offset, w, h, left: cx - w / 2, right: cx + w / 2 };
    });

  const left = placeColumn(prerequisites, 'left');
  const right = placeColumn(targets, 'right');

  const placedById = new Map<string, PlacedNode>();
  placedById.set(current.id, currentBox);
  for (const p of left) placedById.set(p.node.id, p);
  for (const p of right) placedById.set(p.node.id, p);

  // Only draw edges whose endpoints were actually placed.
  const drawableEdges = mindMap.edges.filter((e) => placedById.has(e.from) && placedById.has(e.to));

  const pathFor = (a: PlacedNode, b: PlacedNode) => {
    const goingRight = a.cx < b.cx;
    const x1 = goingRight ? a.right : a.left;
    const x2 = goingRight ? b.left : b.right;
    const midX = (x1 + x2) / 2;
    return `M ${x1} ${a.cy} C ${midX} ${a.cy}, ${midX} ${b.cy}, ${x2} ${b.cy}`;
  };

  const renderNode = (p: PlacedNode, highlighted: boolean) => {
    const color = COLORS[p.node.type];
    const lines = wrap(p.node.label, p.node.type === 'current' ? 20 : 17, 2);
    const fontSize = p.node.type === 'current' ? 15 : 13;
    const startY = p.cy - ((lines.length - 1) * 17) / 2 + 5;
    return (
      <g key={p.node.id}>
        {highlighted && (
          <rect
            x={p.cx - p.w / 2 - 6}
            y={p.cy - p.h / 2 - 6}
            width={p.w + 12}
            height={p.h + 12}
            rx={14}
            fill={color.ring}
            opacity={0.55}
          />
        )}
        <rect
          x={p.cx - p.w / 2}
          y={p.cy - p.h / 2}
          width={p.w}
          height={p.h}
          rx={12}
          fill={color.fill}
          stroke={color.stroke}
          strokeWidth={highlighted ? 2.5 : 1.5}
        />
        <text
          textAnchor="middle"
          x={p.cx}
          y={startY}
          fill={color.text}
          fontSize={fontSize}
          fontWeight={highlighted ? 700 : 600}
        >
          {lines.map((ln, i) => (
            <tspan key={i} x={p.cx} dy={i === 0 ? 0 : 17}>
              {ln}
            </tspan>
          ))}
        </text>
        {highlighted && (
          <text
            textAnchor="middle"
            x={p.cx}
            y={p.cy + p.h / 2 + 18}
            fontSize={11}
            fill={color.stroke}
            fontWeight={700}
          >
            YOU ARE HERE
          </text>
        )}
      </g>
    );
  };

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="w-full max-w-3xl mx-auto"
      role="img"
      aria-label={`Concept map: prerequisites leading to ${current.label}`}
    >
      <defs>
        <marker id="mm-arrow-preq" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#94A3B8" />
        </marker>
        <marker id="mm-arrow-curr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#4F46E5" />
        </marker>
        <marker id="mm-arrow-next" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#10B981" />
        </marker>
      </defs>

      <g>
        {drawableEdges.map((e) => {
          const a = placedById.get(e.from)!;
          const b = placedById.get(e.to)!;
          const incident = e.to === current.id || e.from === current.id;
          const stroke = e.to === current.id ? '#4F46E5' : e.from === current.id ? '#10B981' : '#CBD5E1';
          const marker =
            e.to === current.id
              ? 'url(#mm-arrow-curr)'
              : e.from === current.id
              ? 'url(#mm-arrow-next)'
              : 'url(#mm-arrow-preq)';
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={pathFor(a, b)}
              fill="none"
              stroke={stroke}
              strokeWidth={incident ? 2.4 : 1.6}
              strokeDasharray={incident ? undefined : '5 5'}
              opacity={incident ? 1 : 0.7}
              markerEnd={marker}
            />
          );
        })}
      </g>

      {left.map((p) => renderNode(p, false))}
      {right.map((p) => renderNode(p, false))}
      {renderNode(currentBox, true)}

      {left.length > 0 && (
        <text x={118} y={22} textAnchor="middle" fontSize={11} fill="#64748B" fontWeight={700} letterSpacing="0.08em">
          PREREQUISITES
        </text>
      )}
      {right.length > 0 && (
        <text
          x={WIDTH - 118}
          y={22}
          textAnchor="middle"
          fontSize={11}
          fill="#64748B"
          fontWeight={700}
          letterSpacing="0.08em"
        >
          LEADS TO
        </text>
      )}
    </svg>
  );
}
