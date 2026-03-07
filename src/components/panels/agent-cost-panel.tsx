'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { createClientLogger } from '@/lib/client-logger'
import {
  PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, BarChart, Bar,
} from 'recharts'

const log = createClientLogger('AgentCostPanel')

interface TokenStats {
  totalTokens: number; totalCost: number; requestCount: number
  avgTokensPerRequest: number; avgCostPerRequest: number
}

interface AgentCostData {
  stats: TokenStats
  models: Record<string, { totalTokens: number; totalCost: number; requestCount: number }>
  sessions: string[]
  timeline: Array<{ date: string; cost: number; tokens: number }>
}

interface AgentCostsResponse {
  agents: Record<string, AgentCostData>
  timeframe: string
  recordCount: number
}

interface TaskCostEntry {
  taskId: number
  title: string
  status: string
  priority: string
  assignedTo?: string | null
  project: { id?: number | null; name?: string | null; slug?: string | null; ticketRef?: string | null }
  stats: TokenStats
  models: Record<string, TokenStats>
}

interface TaskCostsResponse {
  summary: TokenStats
  tasks: TaskCostEntry[]
  agents: Record<string, { stats: TokenStats; taskCount: number; taskIds: number[] }>
  unattributed: TokenStats
  timeframe: string
}

const REFRESH_INTERVAL = 30_000 // 30s auto-refresh

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d', '#ffc658', '#ff6b6b']

export function AgentCostPanel() {
  const [selectedTimeframe, setSelectedTimeframe] = useState<'hour' | 'day' | 'week' | 'month'>('day')
  const [data, setData] = useState<AgentCostsResponse | null>(null)
  const [taskData, setTaskData] = useState<TaskCostsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const [expandedSection, setExpandedSection] = useState<'models' | 'tasks'>('tasks')
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    try {
      const [agentRes, taskRes] = await Promise.all([
        fetch(`/api/tokens?action=agent-costs&timeframe=${selectedTimeframe}`),
        fetch(`/api/tokens?action=task-costs&timeframe=${selectedTimeframe}`),
      ])
      const [agentJson, taskJson] = await Promise.all([agentRes.json(), taskRes.json()])
      setData(agentJson)
      setTaskData(taskJson)
    } catch (err) {
      log.error('Failed to load agent costs:', err)
    } finally {
      setIsLoading(false)
    }
  }, [selectedTimeframe])

  useEffect(() => { loadData() }, [loadData])

  // Auto-refresh every 30s
  useEffect(() => {
    refreshTimer.current = setInterval(loadData, REFRESH_INTERVAL)
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current) }
  }, [loadData])

  // Helper: get tasks for a specific agent from task-costs data
  const getAgentTasks = useCallback((agentName: string): TaskCostEntry[] => {
    if (!taskData) return []
    const agentEntry = taskData.agents[agentName]
    if (!agentEntry) return []
    return taskData.tasks.filter(t => agentEntry.taskIds.includes(t.taskId))
  }, [taskData])

  const formatNumber = (num: number) => {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K'
    return num.toString()
  }

  const formatCost = (cost: number) => '$' + cost.toFixed(4)

  const agents = data?.agents ? Object.entries(data.agents) : []
  const sortedAgents = agents.sort(([, a], [, b]) => b.stats.totalCost - a.stats.totalCost)

  const totalCost = agents.reduce((sum, [, a]) => sum + a.stats.totalCost, 0)
  const totalAgents = agents.length

  const mostExpensive = sortedAgents[0]
  const mostEfficient = agents.length > 0
    ? agents.reduce((best, curr) => {
        const currCostPer1k = curr[1].stats.totalCost / Math.max(1, curr[1].stats.totalTokens) * 1000
        const bestCostPer1k = best[1].stats.totalCost / Math.max(1, best[1].stats.totalTokens) * 1000
        return currCostPer1k < bestCostPer1k ? curr : best
      })
    : null

  // Pie chart data
  const pieData = sortedAgents.slice(0, 8).map(([name, a]) => ({
    name,
    value: a.stats.totalCost,
  }))

  // Line chart: top 5 agents over time
  const top5 = sortedAgents.slice(0, 5).map(([name]) => name)
  const allDates = new Set<string>()
  for (const [name, a] of agents) {
    if (top5.includes(name)) {
      for (const t of a.timeline) allDates.add(t.date)
    }
  }
  const trendData = [...allDates].sort().map(date => {
    const point: Record<string, string | number> = { date: date.slice(5) } // MM-DD
    for (const name of top5) {
      const entry = data?.agents[name]?.timeline.find(t => t.date === date)
      point[name] = entry?.cost ?? 0
    }
    return point
  })

  // Efficiency bars
  const efficiencyData = sortedAgents.map(([name, a]) => ({
    name,
    costPer1k: a.stats.totalCost / Math.max(1, a.stats.totalTokens) * 1000,
  }))
  const maxCostPer1k = Math.max(...efficiencyData.map(d => d.costPer1k), 0.0001)

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="border-b border-border pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Agent Cost Breakdown</h1>
            <p className="text-muted-foreground mt-2">Per-agent token usage and spend analysis</p>
          </div>
          <div className="flex space-x-2">
            {(['hour', 'day', 'week', 'month'] as const).map((tf) => (
              <Button
                key={tf}
                onClick={() => setSelectedTimeframe(tf)}
                variant={selectedTimeframe === tf ? 'default' : 'secondary'}
              >
                {tf.charAt(0).toUpperCase() + tf.slice(1)}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          <span className="ml-3 text-muted-foreground">Loading agent costs...</span>
        </div>
      ) : !data || agents.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">
          <div className="text-lg mb-2">No agent cost data available</div>
          <div className="text-sm">Cost data will appear once agents start using tokens</div>
          <Button onClick={loadData} className="mt-4">
            Refresh
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-3xl font-bold text-foreground">{totalAgents}</div>
              <div className="text-sm text-muted-foreground">Active Agents</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-3xl font-bold text-foreground">{formatCost(totalCost)}</div>
              <div className="text-sm text-muted-foreground">Total Cost ({selectedTimeframe})</div>
            </div>
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-3xl font-bold text-orange-500 truncate">{mostExpensive?.[0] || '-'}</div>
              <div className="text-sm text-muted-foreground">Most Expensive</div>
              {mostExpensive && <div className="text-xs text-muted-foreground mt-1">{formatCost(mostExpensive[1].stats.totalCost)} ({((mostExpensive[1].stats.totalCost / Math.max(totalCost, 0.0001)) * 100).toFixed(0)}%)</div>}
            </div>
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-3xl font-bold text-green-500 truncate">{mostEfficient?.[0] || '-'}</div>
              <div className="text-sm text-muted-foreground">Most Efficient</div>
              {mostEfficient && (
                <div className="text-xs text-muted-foreground mt-1">
                  ${(mostEfficient[1].stats.totalCost / Math.max(1, mostEfficient[1].stats.totalTokens) * 1000).toFixed(4)}/1K tokens
                </div>
              )}
            </div>
            <div className="bg-card border border-border rounded-lg p-5">
              <div className="text-3xl font-bold text-foreground">
                {taskData ? `${((1 - taskData.unattributed.totalCost / Math.max(totalCost, 0.0001)) * 100).toFixed(0)}%` : '-'}
              </div>
              <div className="text-sm text-muted-foreground">Task-Attributed</div>
              {taskData && taskData.unattributed.totalCost > 0 && (
                <div className="text-xs text-muted-foreground mt-1">{formatCost(taskData.unattributed.totalCost)} unattributed</div>
              )}
            </div>
          </div>

          {/* Charts */}
          <div className="grid lg:grid-cols-2 gap-6">
            {/* Cost Distribution Pie */}
            <div className="bg-card border border-border rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Cost Distribution by Agent</h2>
              <div className="h-64">
                {pieData.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No cost data</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={80} paddingAngle={5} dataKey="value">
                        {pieData.map((_, i) => (
                          <Cell key={`cell-${i}`} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatCost(Number(value))} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Cost Trend Lines */}
            <div className="bg-card border border-border rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Cost Trends (Top 5 Agents)</h2>
              <div className="h-64">
                {trendData.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No trend data</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis />
                      <Tooltip formatter={(value) => formatCost(Number(value))} />
                      <Legend />
                      {top5.map((name, i) => (
                        <Line key={name} type="monotone" dataKey={name} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          {/* Agent Cost Comparison Bar Chart */}
          {sortedAgents.length > 1 && (
            <div className="bg-card border border-border rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Cost Comparison</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={sortedAgents.slice(0, 10).map(([name, a]) => ({
                    name: name.length > 12 ? name.slice(0, 11) + '…' : name,
                    cost: Number(a.stats.totalCost.toFixed(4)),
                    tokens: a.stats.totalTokens,
                    requests: a.stats.requestCount,
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(value, dataKey) =>
                      dataKey === 'cost' ? formatCost(Number(value)) : formatNumber(Number(value))
                    } />
                    <Legend />
                    <Bar dataKey="cost" fill="#0088FE" name="Cost ($)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Cost Efficiency Comparison */}
          <div className="bg-card border border-border rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Cost Efficiency ($/1K Tokens per Agent)</h2>
            <div className="space-y-2">
              {efficiencyData.map(({ name, costPer1k }) => (
                <div key={name} className="flex items-center text-sm">
                  <div className="w-32 truncate text-muted-foreground font-medium">{name}</div>
                  <div className="flex-1 mx-3">
                    <div className="w-full bg-secondary rounded-full h-2">
                      <div
                        className="bg-blue-500 h-2 rounded-full"
                        style={{ width: `${(costPer1k / maxCostPer1k) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-24 text-right text-xs text-muted-foreground">${costPer1k.toFixed(4)}/1K</div>
                </div>
              ))}
            </div>
          </div>

          {/* Agent Cost Ranking Table */}
          <div className="bg-card border border-border rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Agent Cost Ranking</h2>
            <div className="space-y-2 max-h-[600px] overflow-y-auto">
              {sortedAgents.map(([name, a], index) => {
                const costShare = ((a.stats.totalCost / Math.max(totalCost, 0.0001)) * 100)
                const agentTasks = getAgentTasks(name)
                return (
                  <div key={name} className="border border-border rounded-lg overflow-hidden">
                    <Button
                      onClick={() => setExpandedAgent(expandedAgent === name ? null : name)}
                      variant="ghost"
                      className="w-full p-4 h-auto flex items-center justify-between text-left"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-6">#{index + 1}</span>
                        <span className="font-medium text-foreground">{name}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                          {a.sessions.length} session{a.sessions.length !== 1 ? 's' : ''}
                        </span>
                        {agentTasks.length > 0 && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500">
                            {agentTasks.length} task{agentTasks.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-6 text-sm">
                        <div className="text-right">
                          <div className="font-medium text-foreground">{formatCost(a.stats.totalCost)}</div>
                          <div className="text-xs text-muted-foreground">{costShare.toFixed(1)}% of total</div>
                        </div>
                        <div className="text-right">
                          <div className="text-muted-foreground">{formatNumber(a.stats.totalTokens)} tokens</div>
                          <div className="text-xs text-muted-foreground">{a.stats.requestCount} reqs</div>
                        </div>
                        <svg
                          className={`w-4 h-4 text-muted-foreground transition-transform ${expandedAgent === name ? 'rotate-180' : ''}`}
                          viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                        >
                          <polyline points="4,6 8,10 12,6" />
                        </svg>
                      </div>
                    </Button>

                    {expandedAgent === name && (
                      <div className="px-4 pb-4 border-t border-border bg-secondary/30">
                        {/* Tab switcher for expanded content */}
                        <div className="flex gap-2 pt-3 mb-3">
                          <Button
                            variant={expandedSection === 'tasks' ? 'default' : 'ghost'}
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); setExpandedSection('tasks') }}
                          >
                            Tasks ({agentTasks.length})
                          </Button>
                          <Button
                            variant={expandedSection === 'models' ? 'default' : 'ghost'}
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); setExpandedSection('models') }}
                          >
                            Models ({Object.keys(a.models).length})
                          </Button>
                        </div>

                        {expandedSection === 'tasks' && (
                          <div className="text-sm">
                            {agentTasks.length === 0 ? (
                              <div className="text-xs text-muted-foreground italic py-2">No task-attributed costs for this agent</div>
                            ) : (
                              <div className="space-y-1.5">
                                {agentTasks.map((task) => {
                                  const taskShare = ((task.stats.totalCost / Math.max(a.stats.totalCost, 0.0001)) * 100)
                                  return (
                                    <div key={task.taskId} className="flex items-center justify-between text-xs">
                                      <div className="flex items-center gap-2 min-w-0 flex-1">
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                          task.priority === 'critical' ? 'bg-red-500/10 text-red-500' :
                                          task.priority === 'high' ? 'bg-orange-500/10 text-orange-500' :
                                          task.priority === 'medium' ? 'bg-yellow-500/10 text-yellow-500' :
                                          'bg-secondary text-muted-foreground'
                                        }`}>{task.priority}</span>
                                        {task.project.ticketRef && (
                                          <span className="text-muted-foreground font-mono">{task.project.ticketRef}</span>
                                        )}
                                        <span className="text-foreground truncate">{task.title}</span>
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                          task.status === 'done' ? 'bg-green-500/10 text-green-500' :
                                          task.status === 'in_progress' ? 'bg-blue-500/10 text-blue-500' :
                                          'bg-secondary text-muted-foreground'
                                        }`}>{task.status}</span>
                                      </div>
                                      <div className="flex gap-3 ml-2 shrink-0">
                                        <span className="text-muted-foreground">{taskShare.toFixed(0)}%</span>
                                        <span className="font-medium text-foreground w-16 text-right">{formatCost(task.stats.totalCost)}</span>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )}

                        {expandedSection === 'models' && (
                          <div className="text-sm">
                            <div className="space-y-1.5">
                              {Object.entries(a.models)
                                .sort(([, x], [, y]) => y.totalCost - x.totalCost)
                                .map(([model, stats]) => {
                                  const displayName = model.split('/').pop() || model
                                  return (
                                    <div key={model} className="flex items-center justify-between text-xs">
                                      <span className="text-muted-foreground">{displayName}</span>
                                      <div className="flex gap-4">
                                        <span>{formatNumber(stats.totalTokens)} tokens</span>
                                        <span>{stats.requestCount} reqs</span>
                                        <span className="font-medium text-foreground">{formatCost(stats.totalCost)}</span>
                                      </div>
                                    </div>
                                  )
                                })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
