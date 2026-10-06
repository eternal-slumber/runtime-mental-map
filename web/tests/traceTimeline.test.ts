import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTraceFlows, type TimelineTrace } from '../src/traceTimeline.ts'

const trace = (
  trace_id: string,
  started_at_unix_us: number,
  flow_id?: string,
  parent_trace_id?: string,
): TimelineTrace => ({
  trace_id,
  service_name: 'foodtracker',
  flow_id,
  parent_trace_id,
  started_at_unix_us,
})

test('groups page requests, preserves chronological order and nests real parents', () => {
  const flows = buildTraceFlows([
    trace('profile', 30, 'page-1', 'root'),
    trace('root', 10, 'page-1'),
    trace('meals', 20, 'page-1'),
    trace('legacy', 40),
  ])

  assert.equal(flows.length, 2)
  assert.equal(flows[0].correlated, false)
  assert.deepEqual(flows[1].nodes.map((node) => node.trace.trace_id), ['root', 'meals'])
  assert.deepEqual(flows[1].nodes[0].children.map((node) => node.trace.trace_id), ['profile'])
})

test('keeps missing and cyclic parents at the root', () => {
  const [flow] = buildTraceFlows([
    trace('missing', 10, 'page-1', 'not-collected'),
    trace('a', 20, 'page-1', 'b'),
    trace('b', 30, 'page-1', 'a'),
  ])

  assert.deepEqual(flow.nodes.map((node) => node.trace.trace_id), ['missing', 'a', 'b'])
})
