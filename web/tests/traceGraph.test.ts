import { initialLayout, architectureFields } from '../src/canvasLayout.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  groupGraphByClass,
  summarizeGroupMembers,
  traceToGraph,
  type SpanNode,
  type TraceView,
} from '../src/traceGraph.ts'

function span(
  id: string,
  parentId: string | null,
  kind: SpanNode['kind'],
  name: string,
  children: SpanNode[] = [],
  durationNs = 1,
): SpanNode {
  return {
    protocol_version: 1,
    service_name: 'foodtracker',
    trace_id: 'trace-1',
    span_id: id,
    parent_id: parentId,
    kind,
    runtime: 'php',
    framework: 'slim',
    layer: null,
    name,
    class: null,
    method: null,
    started_at_unix_us: 1,
    duration_ns: durationNs,
    outcome: 'success',
    children,
  }
}

test('converts a trace tree and optionally hides service SQL', () => {
  const select = span(
    'select',
    'repository',
    'sql',
    'SQL SELECT * FROM users',
    [],
    2_000_000,
  )
  const repository = span(
    'repository',
    'controller',
    'method',
    'App\\Repositories\\UserRepository::find',
    [select],
    6_000_000,
  )
  repository.layer = 'repository'
  repository.class = 'App\\Repositories\\UserRepository'
  repository.method = 'find'

  const currentUser = span(
    'current-user',
    'controller',
    'method',
    'App\\Controllers\\UserController::currentUser',
    [],
    500_000,
  )
  currentUser.layer = 'controller'
  currentUser.class = 'App\\Controllers\\UserController'
  currentUser.method = 'currentUser'

  const controller = span(
    'controller',
    'request',
    'method',
    'App\\Controllers\\UserController::index',
    [currentUser, repository],
    8_000_000,
  )
  controller.layer = 'controller'
  controller.class = 'App\\Controllers\\UserController'
  controller.method = 'index'

  const root = span(
    'request',
    null,
    'request',
    'GET /test',
    [
      span('set', 'request', 'sql', "SQL SET time_zone = '+00:00'", [], 1_000_000),
      controller,
    ],
    10_000_000,
  )
  const trace: TraceView = {
    trace_id: 'trace-1',
    status: 'complete',
    span_count: 6,
    root,
    orphans: [],
    missing_parents: [],
    errors: [],
  }

  const full = traceToGraph(trace)
  assert.equal(full.nodes.length, 6)
  assert.equal(full.edges.length, 5)

  const filtered = traceToGraph(trace, true)
  assert.deepEqual(
    filtered.nodes.map((node) => node.id),
    ['request', 'controller', 'current-user', 'repository', 'select'],
  )
  assert.deepEqual(
    filtered.nodes.map((node) => node.depth),
    [0, 1, 2, 2, 3],
  )
  assert.deepEqual(
    filtered.nodes.map((node) => node.sequence),
    [0, 1, 2, 3, 4],
  )
  assert.deepEqual(
    filtered.nodes.map((node) => node.lane),
    ['request', 'controller', 'controller', 'repository', 'database'],
  )
  assert.deepEqual(
    filtered.edges.map((edge) => [edge.source, edge.target]),
    [
      ['request', 'controller'],
      ['controller', 'current-user'],
      ['controller', 'repository'],
      ['repository', 'select'],
    ],
  )

  const controllerNode = filtered.nodes.find((node) => node.id === 'controller')
  assert.ok(controllerNode)
  assert.equal(controllerNode.shortClassName, 'UserController')
  assert.equal(controllerNode.methodName, 'index')
  assert.equal(controllerNode.selfDurationNs, 1_500_000)
  assert.strictEqual(controllerNode.span, controller)

  const repositoryNode = filtered.nodes.find((node) => node.id === 'repository')
  assert.ok(repositoryNode)
  assert.equal(repositoryNode.selfDurationNs, 4_000_000)

  const requestNode = filtered.nodes.find((node) => node.id === 'request')
  assert.ok(requestNode)
  assert.equal(requestNode.selfDurationNs, 1_000_000)

  const grouped = groupGraphByClass(filtered)
  const controllerGroup = grouped.nodes.find(
    (node) => node.id === 'class:App\\Controllers\\UserController',
  )
  assert.ok(controllerGroup)
  assert.deepEqual(
    controllerGroup.members.map((node) => node.methodName),
    ['index', 'currentUser'],
  )
  const currentUserNode = controllerGroup.members[1]
  assert.ok(currentUserNode)
  const methodNode = (
    id: string,
    method: string,
    sequence: number,
    siblingIndex: number,
  ) => ({
    ...currentUserNode,
    id,
    sequence,
    siblingIndex,
    methodName: method,
    durationNs: 100_000,
    selfDurationNs: 100_000,
    span: {
      ...currentUserNode.span,
      span_id: id,
      method,
      parent_id: 'controller',
    },
  })
  const summaries = summarizeGroupMembers({
    ...controllerGroup,
    members: [
      methodNode('validate-1', 'validate', 10, 0),
      methodNode('validate-2', 'validate', 15, 1),
      methodNode('save', 'save', 20, 2),
      methodNode('validate-3', 'validate', 25, 3),
      methodNode('send', 'send', 30, 4),
    ],
  })
  assert.deepEqual(
    summaries.map((summary) => [
      summary.labels,
      summary.count,
      summary.totalDurationNs,
    ]),
    [
      [['validate()'], 2, 200_000],
      [['save()'], 1, 100_000],
      [['validate()'], 1, 100_000],
      [['send()'], 1, 100_000],
    ],
  )

  const uploadIteration = (
    parentId: string,
    sequence: number,
  ) => ['thumbnailRelativePath', 'fullPath', 'isManagedUploadPath'].map(
    (method, siblingIndex) => ({
      ...methodNode(`${parentId}-${method}`, method, sequence + siblingIndex, siblingIndex),
      parentContextKey: method === 'isManagedUploadPath'
        ? 'method:App\\Services\\UploadedFileStorage:fullPath'
        : 'method:App\\Services\\MealService:imageCacheToken',
      span: {
        ...currentUserNode.span,
        span_id: `${parentId}-${method}`,
        parent_id: method === 'isManagedUploadPath' ? `${parentId}-fullPath` : parentId,
        method,
      },
    }),
  )
  const repeatedSequence = summarizeGroupMembers({
    ...controllerGroup,
    members: Array.from(
      { length: 26 },
      (_, index) => uploadIteration(`image-token-${index}`, 40 + index * 10),
    ).flat(),
  })
  assert.deepEqual(
    repeatedSequence.map((summary) => [summary.labels, summary.count]),
    [[
      ['thumbnailRelativePath()', 'fullPath()', 'isManagedUploadPath()'],
      26,
    ]],
  )
  assert.deepEqual(
    grouped.edges.map((edge) => [edge.source, edge.target]),
    [
      ['request', 'class:App\\Controllers\\UserController'],
      [
        'class:App\\Controllers\\UserController',
        'class:App\\Repositories\\UserRepository',
      ],
      ['class:App\\Repositories\\UserRepository', 'database:queries'],
    ],
  )

  const fullDatabaseGroup = groupGraphByClass(full).nodes.find(
    (node) => node.id === 'database:queries',
  )
  assert.ok(fullDatabaseGroup)
  assert.deepEqual(
    fullDatabaseGroup.members.map((node) => node.id),
    ['set', 'select'],
  )

  const layout = initialLayout(grouped)
  assert.deepEqual(
    architectureFields(grouped).map((column) => column.lane),
    ['request', 'controller', 'repository', 'database'],
  )
  assert.deepEqual(
    layout.map((node) => [node.id, node.x]),
    [
      ['request', 24],
      ['class:App\\Controllers\\UserController', 478],
      ['class:App\\Repositories\\UserRepository', 898],
      ['database:queries', 1284],
    ],
  )
})
