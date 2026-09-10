import { methodRows, querySections, type GroupedCanvasGraph, type SemanticLane } from './traceGraph.ts'

export type Point = { x: number; y: number }
export type Box = Point & { id: string; width: number; height: number; lane?: SemanticLane }
export type StoredPosition = Point & { hidden?: boolean; collapsed?: boolean; pinned?: boolean }
const lanes: SemanticLane[] = ['request', 'controller', 'application', 'domain', 'repository', 'database', 'external', 'unknown']
export const CARD_WIDTH = 304
export const RESOURCE_WIDTH = 392
export const GAP = 36
const MAX_CANVAS_COORDINATE = 1_000_000
const ANCHOR_TOP = 64
const BUSINESS_TOP = 360
const DEPTH_STEP = 72
const QUERY_GROUP_ROWS_MAX_HEIGHT = 180

const validCoordinate = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) && Math.abs(value!) <= MAX_CANVAS_COORDINATE ? value! : fallback

export function safePosition(position: Partial<Point> | undefined, fallback: Point): Point {
  return {
    x: validCoordinate(position?.x, fallback.x),
    y: validCoordinate(position?.y, fallback.y),
  }
}

export function overlaps(a: Box, b: Box, gap = GAP): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
}

export function freePosition(box: Box, occupied: Box[]): Box {
  let result = { ...box }
  // ponytail: deterministic linear scans suit local maps; use a spatial index for thousands of cards.
  for (;;) {
    const hit = occupied.find((other) => overlaps(result, other))
    if (!hit) return result
    result = { ...result, y: hit.y + hit.height + GAP }
  }
}

export const FIELD_PADDING = 24
export const MIN_FIELD_WIDTH = CARD_WIDTH + FIELD_PADDING * 2
const minimumWidth = (lane: SemanticLane) => lane === 'database'
  ? RESOURCE_WIDTH + FIELD_PADDING * 2
  : MIN_FIELD_WIDTH
export type ArchitectureField = {
  id: string
  lane: SemanticLane
  x: number
  width: number
  manualMinWidth: number
}
export type SavedField = {
  layer: SemanticLane
  x: number
  width: number
  manual_min_width: number
}

export function architectureFields(graph: GroupedCanvasGraph, saved: SavedField[] = []): ArchitectureField[] {
  let x = validCoordinate(saved[0]?.x, 0)
  return lanes.filter((lane) => graph.nodes.some((node) => node.lane === lane)).map((lane) => {
    const id = `field:${lane}`
    const stored = saved.find((field) => field.layer === lane)
    const baseWidth = minimumWidth(lane)
    const manualMinWidth = Math.max(baseWidth, validCoordinate(stored?.manual_min_width, baseWidth))
    const width = Math.max(manualMinWidth, validCoordinate(stored?.width, 420))
    const field = { id, lane, x, width, manualMinWidth }
    x += width
    return field
  })
}

export function fieldState(fields: ArchitectureField[]): SavedField[] {
  return fields.map((field) => ({
    layer: field.lane,
    x: field.x,
    width: field.width,
    manual_min_width: field.manualMinWidth,
  }))
}

export function resizeField(
  boxes: Box[],
  fields: ArchitectureField[],
  id: string,
  width: number,
  manual = true,
): { boxes: Box[]; fields: ArchitectureField[] } {
  const field = fields.find((item) => item.id === id)
  width = validCoordinate(width, field?.width ?? MIN_FIELD_WIDTH)
  const contentWidth = field
    ? Math.max(0, ...boxes.filter((box) => box.lane === field.lane)
      .map((box) => box.x + box.width + FIELD_PADDING - field.x))
    : 0
  let x = fields[0]?.x ?? 0
  const nextFields = fields.map((field) => {
    const baseWidth = minimumWidth(field.lane)
    const manualMinWidth = field.id === id && manual
      ? Math.max(baseWidth, width)
      : field.manualMinWidth
    const next = {
      ...field,
      x,
      manualMinWidth,
      width: field.id === id ? Math.max(manualMinWidth, width, contentWidth) : field.width,
    }
    x += next.width
    return next
  })
  const nextBoxes = boxes.map((box) => {
    const before = fields.find((field) => field.lane === box.lane)
    const after = nextFields.find((field) => field.lane === box.lane)
    return { ...box, x: box.x + (after && before ? after.x - before.x : 0) }
  })
  return { boxes: nextBoxes, fields: nextFields }
}

export function clampPositionToField(box: Box, field: ArchitectureField, position: Point): Point {
  const safe = safePosition(position, box)
  const left = field.x + FIELD_PADDING
  const right = Math.max(left, field.x + field.width - box.width - FIELD_PADDING)
  return { x: Math.min(right, Math.max(left, safe.x)), y: safe.y }
}

export function initialLayout(graph: GroupedCanvasGraph, saved: Record<string, StoredPosition> = {}, savedFields: SavedField[] = []): Box[] {
  const fields = architectureFields(graph, savedFields)
  const boxes = graph.nodes.map((node): Box => {
    const field = fields.find((item) => item.lane === node.lane)!
    const database = node.lane === 'database'
    const request = node.members[0]?.kind === 'request'
    const resource = database || node.lane === 'external'
    const width = database ? RESOURCE_WIDTH : CARD_WIDTH
    const height = database
      ? 146 + querySections(node, graph).reduce(
        (total, section) => total + 30 + Math.min(QUERY_GROUP_ROWS_MAX_HEIGHT, section.queries.length * 58), 0,
      )
      : request || saved[node.id]?.collapsed ? 118
        : 106 + methodRows(node).reduce((total, row) => total + 34 + (row.index === 0 && row.summary.labels.length > 1 ? 30 : 0), 0)
    return {
      id: node.id,
      lane: node.lane,
      x: request ? field.x + FIELD_PADDING
        : resource ? field.x + field.width - width - FIELD_PADDING
          : field.x + (field.width - width) / 2,
      y: request || resource ? ANCHOR_TOP : BUSINESS_TOP,
      width,
      height,
    }
  })

  for (const box of boxes) {
    if (saved[box.id]) Object.assign(box, safePosition(saved[box.id], box))
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const business = boxes.filter((box) => box.lane !== 'request' && box.lane !== 'database' && box.lane !== 'external')
  const businessDepths = business.flatMap((box) => byId.get(box.id)?.members.map((member) => member.depth) ?? [])
  const minimumDepth = businessDepths.length ? Math.min(...businessDepths) : 0
  const occupied = boxes.filter((box) => saved[box.id] && !saved[box.id].hidden)
  for (const box of business.sort((left, right) => {
    const leftNode = byId.get(left.id)!
    const rightNode = byId.get(right.id)!
    return Math.min(...leftNode.members.map((member) => member.depth)) - Math.min(...rightNode.members.map((member) => member.depth))
      || Math.min(...leftNode.members.map((member) => member.sequence)) - Math.min(...rightNode.members.map((member) => member.sequence))
  })) {
    if (saved[box.id]) continue
    const depth = Math.min(...byId.get(box.id)!.members.map((member) => member.depth))
    box.y = BUSINESS_TOP + Math.max(0, depth - minimumDepth) * DEPTH_STEP
    Object.assign(box, freePosition(box, occupied.filter((candidate) => candidate.lane === box.lane)))
    occupied.push(box)
  }

  return boxes
}
