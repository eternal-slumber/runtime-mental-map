import assert from 'node:assert/strict'
import test from 'node:test'
import {
  groupGraphByClass,
  layoutGraphByLane,
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
  assert.deepEqual(
    grouped.edges.map((edge) => [edge.source, edge.target]),
    [
      ['request', 'class:App\\Controllers\\UserController'],
      [
        'class:App\\Controllers\\UserController',
        'class:App\\Repositories\\UserRepository',
      ],
      ['class:App\\Repositories\\UserRepository', 'select'],
    ],
  )

  const layout = layoutGraphByLane(grouped)
  assert.deepEqual(
    layout.columns.map((column) => column.lane),
    ['request', 'controller', 'repository', 'database'],
  )
  assert.deepEqual(
    layout.nodes.map((node) => [node.id, node.position.x]),
    [
      ['request', 0],
      ['class:App\\Controllers\\UserController', 300],
      ['class:App\\Repositories\\UserRepository', 600],
      ['select', 900],
    ],
  )
})
