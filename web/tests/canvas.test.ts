import assert from 'node:assert/strict'
import test from 'node:test'
import { focusExecution, groupDuration, groupGraphByClass, methodRows, querySections, querySource, traceToGraph, type SpanNode, type TraceView } from '../src/traceGraph.ts'
import { architectureFields, clampPositionToField, initialLayout, resizeField, overlaps, safePosition, type Box } from '../src/canvasLayout.ts'

function method(id: string, cls: string, children: SpanNode[] = []): SpanNode {
  return { protocol_version: 1, service_name: 'canvas-check', trace_id: 'canvas-check', span_id: id,
    parent_id: null, kind: 'method', runtime: 'php', framework: 'slim', layer: 'application', name: `${cls}::${id}`,
    class: cls, method: id, started_at_unix_us: 1, duration_ns: 1_000_000, children }
}
const query = (id: string): SpanNode => ({ ...method(id, ''), kind: 'sql', layer: 'database', name: 'SQL SELECT * FROM meals WHERE user_id = ?', class: null, method: null })
function graphOf(root: SpanNode) {
  const parent = (node: SpanNode) => node.children.forEach((child) => { child.parent_id = node.span_id; parent(child) })
  parent(root)
  const trace: TraceView = { trace_id: 'canvas-check', status: 'complete', span_count: 0, root, orphans: [], missing_parents: [], errors: [] }
  return { trace, graph: groupGraphByClass(traceToGraph(trace)) }
}

test('semantic dependencies retain anchors, query provenance and exact execution without mutating spans', () => {
  const q1 = query('q1'), q2 = query('q2'), q3 = query('q3')
  const find1 = method('find1', 'Repo', [q1]); find1.method = 'find'
  const find2 = method('find2', 'Repo', [q2]); find2.method = 'find'
  const unrelated = method('save', 'OtherRepo', [q3])
  const inner = method('currentUser', 'Controller')
  const root = { ...method('request', '', [method('history', 'Controller', [inner, find1, find2]), unrelated]), kind: 'request' as const, class: null, layer: 'request' }
  const { trace, graph } = graphOf(root)
  const original = JSON.stringify(trace)
  const db = graph.nodes.find((node) => node.id === 'database:queries')!
  assert.deepEqual(db.members.map((node) => node.id), ['q1', 'q2', 'q3'])
  const repo = graph.nodes.find((node) => node.id === 'class:Repo')!
  const row = methodRows(repo)[0]
  assert.equal(row.summary.count, 2)
  assert.deepEqual(row.members.map((node) => node.id), ['find1', 'find2'])
  const dependencies = graph.edges.filter((edge) => edge.source === repo.id && edge.target === db.id)
  const dependency = dependencies.find((edge) => edge.calls.some((call) => call.target === 'q1'))!
  const sections = querySections(db, graph)
  assert.equal(dependencies.length, 2)
  assert.equal(dependency.sourceHandle, row.id)
  assert.equal(dependency.targetHandle, sections.find((section) => section.queries[0].id === 'q1')?.id)
  assert.deepEqual(dependency.calls.map((edge) => [edge.source, edge.target]), [['find1', 'q1']])
  assert.equal(dependency.durationNs, 1_000_000)
  assert.equal(querySource(db.members[0], graph)?.id, 'find1')
  assert.equal(graph.edges.find((edge) => edge.source === 'request')?.sourceHandle, 'overview')
  assert.deepEqual([...focusExecution(graph, ['q1'])].sort(), ['q1', 'find1', 'history', 'request'].sort())
  assert.deepEqual([...focusExecution(graph, ['find1'])].sort(), ['q1', 'find1', 'history', 'request'].sort())
  assert.ok(graph.executionEdges.some((edge) => edge.source === 'history' && edge.target === 'currentUser'))
  assert.equal(JSON.stringify(trace), original)
})

test('class inclusive time excludes nested reentry through another class', () => {
  const root = method('outer', 'Service', [method('repository', 'Repo', [method('reentry', 'Service')])])
  const { graph } = graphOf(root)
  assert.equal(groupDuration(graph.nodes[0], graph), 1_000_000)
})

test('new entities use free space at field center while saved coordinates stay exact', () => {
  const { graph } = graphOf(method('root', 'A', [method('child', 'B'), method('next', 'C')]))
  const saved = { 'class:A': { x: 24, y: -250, pinned: false }, 'class:B': { x: 50, y: 500, collapsed: true } }
  const boxes = initialLayout(graph, saved)
  assert.deepEqual([boxes[0].x, boxes[0].y], [24, -250])
  assert.deepEqual([boxes[1].x, boxes[1].y], [50, 500])
  assert.equal(boxes[2].x, 58)
  assert.ok(!overlaps(boxes[2], boxes[0]) && !overlaps(boxes[2], boxes[1]))
  const restored = initialLayout(graph, Object.fromEntries(boxes.map((box) => [box.id, { x: box.x, y: box.y }])))
  assert.deepEqual(restored.map((box) => [box.x, box.y]), boxes.map((box) => [box.x, box.y]))
})

test('auto layout places request and database in top corners above business flow', () => {
  const databaseQuery = query('business-query')
  const repository = method('find', 'MealRepository', [databaseQuery]); repository.layer = 'repository'
  const controller = method('index', 'MealController', [repository]); controller.layer = 'controller'
  const request = { ...method('request', '', [controller]), kind: 'request' as const, class: null, layer: 'request', name: 'GET /meals' }
  const { graph } = graphOf(request)
  const boxes = initialLayout(graph)
  const requestBox = boxes.find((box) => box.lane === 'request')!
  const databaseBox = boxes.find((box) => box.lane === 'database')!
  assert.equal(requestBox.y, databaseBox.y)
  assert.ok(boxes.filter((box) => ['controller', 'repository'].includes(box.lane!))
    .every((box) => box.y > requestBox.y + requestBox.height + 100))
  const fields = architectureFields(graph)
  const requestField = fields.find((field) => field.lane === 'request')!
  const databaseField = fields.find((field) => field.lane === 'database')!
  assert.equal(requestBox.x, requestField.x + 24)
  assert.equal(databaseBox.x, databaseField.x + databaseField.width - databaseBox.width - 24)
})

test('query sections put bootstrap and request groups above application callers without changing query order', () => {
  const bootstrap = query('bootstrap')
  const businessA = query('business-a')
  const businessB = query('business-b')
  const lifecycleC = query('lifecycle-c')
  const lifecycleD = query('lifecycle-d')
  const controller = method('index', 'NewsController', [businessA, businessB]); controller.layer = 'controller'
  const request = { ...method('request', '', [bootstrap, controller, lifecycleC, lifecycleD]), kind: 'request' as const, class: null, layer: 'request', name: 'GET /news' }
  const { graph } = graphOf(request)
  const database = graph.nodes.find((node) => node.id === 'database:queries')!
  const sections = querySections(database, graph)
  assert.deepEqual(sections.map((section) => ({
    category: section.category,
    source: section.source?.id,
    queries: section.queries.map((item) => item.id),
  })), [
    { category: 'bootstrap', source: 'request', queries: ['bootstrap'] },
    { category: 'request', source: 'request', queries: ['lifecycle-c', 'lifecycle-d'] },
    { category: 'application', source: 'index', queries: ['business-a', 'business-b'] },
  ])
  const rootDependencies = graph.edges.filter((edge) => edge.source === 'request' && edge.target === database.id)
  const controllerDependency = graph.edges.find((edge) => edge.source === 'class:NewsController' && edge.target === database.id)!
  assert.deepEqual(rootDependencies.map((dependency) => dependency.calls.map((edge) => edge.target)), [
    ['bootstrap'],
    ['lifecycle-c', 'lifecycle-d'],
  ])
  assert.deepEqual(rootDependencies.map((dependency) => dependency.targetHandle), [sections[0].id, sections[1].id])
  assert.deepEqual(controllerDependency.calls.map((edge) => edge.target), ['business-a', 'business-b'])
  assert.equal(controllerDependency.targetHandle, sections[2].id)
  assert.deepEqual([...focusExecution(graph, ['business-a'])].sort(), ['business-a', 'index', 'request'].sort())
})

test('query section categories handle root-only, application-only, multiple callers and hidden service SQL', () => {
  const rootOnly = { ...method('root-only', '', [query('root-a'), query('root-b')]), kind: 'request' as const, class: null, layer: 'request' }
  const rootGraph = graphOf(rootOnly).graph
  assert.deepEqual(querySections(rootGraph.nodes.find((node) => node.id === 'database:queries')!, rootGraph)
    .map((section) => section.category), ['request'])

  const first = method('first', 'FirstController', [query('first-query')]); first.layer = 'controller'
  const second = method('second', 'SecondController', [query('second-query')]); second.layer = 'controller'
  const applicationOnly = { ...method('application-only', '', [first, second]), kind: 'request' as const, class: null, layer: 'request' }
  const applicationGraph = graphOf(applicationOnly).graph
  const applicationSections = querySections(applicationGraph.nodes.find((node) => node.id === 'database:queries')!, applicationGraph)
  assert.deepEqual(applicationSections.map((section) => [section.category, section.source?.id]), [
    ['application', 'first'],
    ['application', 'second'],
  ])

  const service = { ...query('service'), name: 'SQL SET time_zone = UTC' }
  const controller = method('controller', 'Controller', [query('visible')]); controller.layer = 'controller'
  const filteredTrace = graphOf({ ...method('filtered', '', [service, controller]), kind: 'request' as const, class: null, layer: 'request' }).trace
  const filteredGraph = groupGraphByClass(traceToGraph(filteredTrace, true))
  const filteredDatabase = filteredGraph.nodes.find((node) => node.id === 'database:queries')!
  const filteredSections = querySections(filteredDatabase, filteredGraph)
  assert.deepEqual(filteredSections.map((section) => section.queries.map((item) => item.id)), [['visible']])
  assert.equal(filteredGraph.edges.find((edge) => edge.target === filteredDatabase.id)?.targetHandle, filteredSections[0].id)
})

test('auto layout works without a database anchor', () => {
  const controller = method('index', 'NewsController'); controller.layer = 'controller'
  const request = { ...method('request', '', [controller]), kind: 'request' as const, class: null, layer: 'request' }
  const { graph } = graphOf(request)
  const boxes = initialLayout(graph)
  const requestBox = boxes.find((box) => box.lane === 'request')!
  const controllerBox = boxes.find((box) => box.lane === 'controller')!
  assert.equal(boxes.some((box) => box.lane === 'database'), false)
  assert.ok(controllerBox.y > requestBox.y + requestBox.height + 100)
})

test('saved positions remain authoritative when graph fields change', () => {
  const request = { ...method('request', '', [method('work', 'Service'), query('q')]), kind: 'request' as const, class: null, layer: 'request' }
  const { graph } = graphOf(request)
  const savedFields = [
    { layer: 'application' as const, x: 0, width: 420, manual_min_width: 352 },
    { layer: 'database' as const, x: 420, width: 420, manual_min_width: 384 },
  ]
  const boxes = initialLayout(graph, {
    'class:Service': { x: 24, y: 200 },
    'database:queries': { x: 444, y: 300 },
  }, savedFields)
  assert.equal(boxes.find((box) => box.id === 'class:Service')?.x, 24)
  assert.equal(boxes.find((box) => box.id === 'database:queries')?.x, 444)
})

test('drag coordinates never resize fields and invalid positions fall back safely', () => {
  const { graph } = graphOf(method('root', 'A', [method('child', 'B'), query('q')]))
  const fields = architectureFields(graph)
  assert.deepEqual(fields.map((field) => field.lane), ['application', 'database'])
  const boxes: Box[] = [
    { id: 'a', lane: 'application', x: 24, y: -500, width: 304, height: 200 },
    { id: 'db', lane: 'database', x: 444, y: 0, width: 392, height: 118 },
  ]
  const fieldSnapshot = structuredClone(fields)
  const dragged = boxes.map((box) => box.id === 'a' ? { ...box, ...safePosition({ x: 200, y: -500 }, box) } : box)
  assert.deepEqual(dragged.map((box) => box.id), boxes.map((box) => box.id))
  assert.deepEqual([dragged[0].x, dragged[0].y], [200, -500])
  assert.deepEqual(fields, fieldSnapshot)
  assert.deepEqual(clampPositionToField(boxes[0], fields[0], { x: -100, y: -500 }), { x: 24, y: -500 })
  assert.deepEqual(clampPositionToField(boxes[0], fields[0], { x: 10_000, y: -500 }), { x: 92, y: -500 })
  assert.deepEqual(safePosition({ x: Number.NaN, y: Infinity }, boxes[0]), { x: 24, y: -500 })
  const saved = JSON.parse(JSON.stringify([{ layer: 'application', x: 0, width: 620, manual_min_width: 500 }]))
  const restored = architectureFields(graph, saved)
  assert.equal(restored[0].width, 620)
  assert.equal(restored[1].x, 620)
  const moved = resizeField(boxes, fields, 'field:application', 620)
  assert.deepEqual([moved.boxes[1].x, moved.boxes[1].y], [644, 0])
  assert.equal(architectureFields(graph, [{ layer: 'application', x: 0, width: 1, manual_min_width: 1 }])[0].width, 352)
  const migrated = initialLayout(graph, { 'class:A': { x: -100, y: -150 } })
  assert.deepEqual([migrated[0].x, migrated[0].y], [-100, -150])
  const recovered = initialLayout(graph, { 'class:A': { x: Number.NaN, y: Infinity } })[0]
  assert.ok(Number.isFinite(recovered.x) && Number.isFinite(recovered.y))
})

test('service SQL filtering is case insensitive and preserves the raw trace', () => {
  const service = { ...query('setup'), name: 'SQL set search_path to "public"' }
  const { trace } = graphOf(method('request', 'App', [service, query('select')]))
  assert.deepEqual(traceToGraph(trace, true).nodes.map((node) => node.id), ['request', 'select'])
  assert.equal(traceToGraph(trace).nodes.length, 3)
  assert.strictEqual(trace.root!.children[0], service)
})

test('database aggregation stays stable for 0, 1, 5 and 50 queries', () => {
  for (const count of [0, 1, 5, 50]) {
    const request = { ...method('request', '', Array.from({ length: count }, (_, index) => query(`q${index}`))), kind: 'request' as const, class: null, layer: 'request' }
    const { graph } = graphOf(request)
    const database = graph.nodes.find((node) => node.id === 'database:queries')
    assert.equal(database?.members.length ?? 0, count)
    assert.equal(initialLayout(graph).length, graph.nodes.length)
    if (database) {
      const nodeCount = graph.nodes.length
      focusExecution(graph, [database.members[0].id])
      assert.equal(graph.nodes.length, nodeCount)
    }
  }
})

test('layout stays collision-free for hundreds of raw spans', () => {
  const children = Array.from({ length: 120 }, (_, index) => method(`m${index}`, `Service${index}`, [query(`q${index}`)]))
  const request = { ...method('request', '', children), kind: 'request' as const, class: null, layer: 'request' }
  const { graph } = graphOf(request)
  const boxes = initialLayout(graph)
  const application = boxes.filter((box) => box.lane === 'application')
  assert.equal(graph.nodes.flatMap((node) => node.members).length, 241)
  assert.equal(graph.nodes.filter((node) => node.lane === 'database').length, 1)
  assert.equal(boxes.find((box) => box.lane === 'database')?.width, 392)
  for (let index = 0; index < application.length; index++) {
    assert.ok(application.slice(index + 1).every((box) => !overlaps(application[index], box)))
  }
})
