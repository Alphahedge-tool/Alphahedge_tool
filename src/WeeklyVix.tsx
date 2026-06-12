import { useEffect, useMemo, useState } from 'react'
import InhouseStrategyChart from './InhouseStrategyChart'
import { apiPath } from './config'

type Exchange = 'NSE' | 'BSE'

type Session = {
  access_token: string
  user_name: string
  account_id: string
  environment: 'PROD' | 'UAT'
  device_id?: string
  is_demo?: boolean
}

type WeeklyVixProps = {
  session: Session | null
  onBack: () => void
}

type RollingPoint = { ts: number; value: number }

type WeeklyVixResponse = {
  instrument: string
  exchange: Exchange
  points: RollingPoint[]
  latest: number
  message: string
}

type OptionChainResponse = {
  expiry: string
  all_expiries: string[]
  atm: number
  current_price: number
}

const instrumentsByExchange: Record<Exchange, string[]> = {
  NSE: ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'],
  BSE: ['SENSEX', 'BANKEX'],
}

const intervals = ['1m', '3m', '5m', '15m', '30m'] as const

function requestBody(session: Session, extra: Record<string, unknown>) {
  return JSON.stringify({
    session_token: session.access_token,
    device_id: session.device_id ?? 'Nubra-OSS-weekly-vix',
    environment: session.environment,
    ...extra,
  })
}

type ChartPoint = { time: number; value: number }

function toChartData(points: RollingPoint[]): ChartPoint[] {
  const byTime = new Map<number, number>()
  for (const p of points) {
    const seconds = Math.floor(p.ts / 1_000_000_000)
    if (seconds > 0 && p.value > 0) byTime.set(seconds, p.value)
  }
  return Array.from(byTime.entries())
    .sort(([a], [b]) => a - b)
    .map(([time, value]) => ({ time, value }))
}

function appendOrReplace(points: RollingPoint[], timeSeconds: number, value: number): RollingPoint[] {
  if (!Number.isFinite(value) || value <= 0) return points
  const ts = timeSeconds * 1_000_000_000
  const next = points.filter(p => Math.floor(p.ts / 1_000_000_000) !== timeSeconds)
  next.push({ ts, value })
  return next.sort((a, b) => a.ts - b.ts)
}

function alignedValues(timestamps: number[], points: ChartPoint[]) {
  const byTime = new Map(points.map(p => [p.time, p.value]))
  return timestamps.map(t => byTime.get(t) ?? null)
}

export default function WeeklyVix({ session, onBack }: WeeklyVixProps) {
  const [exchange, setExchange] = useState<Exchange>('NSE')
  const [instrument, setInstrument] = useState('NIFTY')
  const [interval, setInterval] = useState<(typeof intervals)[number]>('5m')
  const [expiries, setExpiries] = useState<string[]>([])
  const [loadingExpiry, setLoadingExpiry] = useState(false)
  const [loadingChart, setLoadingChart] = useState(false)
  const [chart, setChart] = useState<WeeklyVixResponse | null>(null)
  const [livePoints, setLivePoints] = useState<RollingPoint[]>([])
  const [liveVix, setLiveVix] = useState<number | null>(null)
  const [liveStatus, setLiveStatus] = useState('Offline')
  const [error, setError] = useState('')
  const intervalSeconds = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800 } as const

  // When exchange changes, reset instrument to first valid one for that exchange
  useEffect(() => {
    setInstrument(instrumentsByExchange[exchange][0])
  }, [exchange])

  // Reset on instrument/exchange change
  useEffect(() => {
    setExpiries([])
    setChart(null)
    setLivePoints([])
    setLiveVix(null)
    setLiveStatus('Offline')
    setError('')
  }, [exchange, instrument])

  // Fetch option chain to get all expiries
  useEffect(() => {
    if (!session || session.is_demo || !instrument) return
    let cancelled = false
    setLoadingExpiry(true)
    fetch(apiPath('/api/market/option-chain'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(session, { exchange, instrument }),
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.detail ?? 'Failed to load expiries')
        return data as OptionChainResponse
      })
      .then(data => {
        if (cancelled) return
        setExpiries(data.all_expiries ?? [])
      })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoadingExpiry(false) })
    return () => { cancelled = true }
  }, [session, exchange, instrument])

  // Fetch historical weekly VIX
  useEffect(() => {
    if (!session || session.is_demo || !instrument || expiries.length === 0) return
    let cancelled = false
    setLoadingChart(true)
    setError('')
    setChart(null)
    setLivePoints([])
    setLiveVix(null)
    setLiveStatus('Loading exact')

    fetch(apiPath('/api/market/weekly-vix'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(session, { exchange, instrument, interval }),
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data?.detail ?? 'Failed to load weekly VIX')
        return data as WeeklyVixResponse
      })
      .then(data => {
        if (cancelled) return
        setChart(data)
        // seed live points from historical
        setLivePoints(data.points ?? [])
        setLiveVix(data.latest)
        setLiveStatus('Exact polling')
      })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoadingChart(false) })

    return () => { cancelled = true }
  }, [session, exchange, instrument, interval, expiries])

  // Poll exact REST snapshots after the first chart load.
  useEffect(() => {
    if (!session || session.is_demo || !instrument || expiries.length === 0 || !chart) return

    let cancelled = false
    const pollMs = Math.max(10_000, Math.min(30_000, intervalSeconds[interval] * 500))
    const pollExactVix = () => {
      fetch(apiPath('/api/market/weekly-vix'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody(session, { exchange, instrument, interval }),
      })
        .then(async r => {
          const data = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(data?.detail ?? 'Failed to refresh exact weekly VIX')
          return data as WeeklyVixResponse
        })
        .then(data => {
          if (cancelled) return
          setLiveVix(data.latest)
          for (const point of data.points ?? []) {
            const seconds = Math.floor(point.ts / 1_000_000_000)
            setLivePoints(prev => appendOrReplace(prev, seconds, point.value))
          }
          setError('')
          setLiveStatus('Exact polling')
        })
        .catch(err => {
          if (cancelled) return
          setLiveStatus('Refresh error')
          setError(err.message)
        })
    }

    const timer = window.setInterval(pollExactVix, pollMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session, exchange, instrument, expiries, interval, chart])

  const chartData = useMemo(() => {
    const points = toChartData(livePoints.length > 0 ? livePoints : (chart?.points ?? []))
    const timestamps = points.map(p => p.time)
    const values = alignedValues(timestamps, points)
    return {
      timestamps,
      series: points.length > 0
        ? [{ label: 'Weekly VIX', values, stroke: '#f0b90b', axisId: 'right' as const, width: 2 }]
        : [],
    }
  }, [livePoints, chart])

  const latestVix = liveVix ?? chart?.latest ?? 0
  const hasData = chartData.timestamps.length > 0

  return (
    <main className="strategy-chart-shell">
      <section className="strategy-chart-container">
        <header className="strategy-chart-header">
          <div className="strategy-chart-heading">
            <span className="strategy-chart-kicker">Weekly VIX</span>
          </div>
          <div className="strategy-top-controls">
            <label className="strategy-control">
              <span>Exchange</span>
              <select value={exchange} onChange={e => setExchange(e.target.value as Exchange)}>
                {Object.keys(instrumentsByExchange).map(ex => <option key={ex}>{ex}</option>)}
              </select>
            </label>
            <label className="strategy-control">
              <span>Instrument</span>
              <select value={instrument} onChange={e => setInstrument(e.target.value)}>
                {instrumentsByExchange[exchange].map(ins => <option key={ins}>{ins}</option>)}
              </select>
            </label>
            <label className="strategy-control">
              <span>Timeframe</span>
              <select value={interval} onChange={e => setInterval(e.target.value as typeof interval)}>
                {intervals.map(i => <option key={i}>{i}</option>)}
              </select>
            </label>
          </div>
          <button type="button" className="strategy-chart-back" onClick={onBack}>
            Back to Dashboard
          </button>
        </header>

        <div className="strategy-chart-grid">
          <section className="strategy-chart-stage">
            <div className="strategy-chart-canvas" aria-label="Weekly VIX chart">
              <InhouseStrategyChart
                title="Weekly VIX"
                value={latestVix > 0 ? latestVix.toFixed(2) : '--'}
                timestamps={chartData.timestamps}
                series={chartData.series}
              />
              <div className={hasData ? 'strategy-chart-status top-left' : 'strategy-chart-empty'}>
                <strong>
                  {loadingChart
                    ? 'Loading Weekly VIX...'
                    : hasData
                      ? `${instrument} Weekly VIX`
                      : 'Select instrument'}
                </strong>
                {(error || (!hasData && !loadingChart)) && (
                  <span>{error || 'CBOE-style 7-day interpolated VIX from all active expiries.'}</span>
                )}
              </div>
            </div>
          </section>
        </div>

        <footer className="strategy-stat-row">
          <div className="strategy-stat"><span>Weekly VIX</span><strong>{latestVix > 0 ? latestVix.toFixed(2) : '--'}</strong></div>
          <div className="strategy-stat"><span>Instrument</span><strong>{instrument}</strong></div>
          <div className="strategy-stat"><span>Expiries</span><strong>{loadingExpiry ? '...' : expiries.length}</strong></div>
          <div className="strategy-stat"><span>Timeframe</span><strong>{interval}</strong></div>
          <div className="strategy-stat"><span>Status</span><strong>{loadingExpiry || loadingChart ? 'Loading' : error ? 'Error' : liveStatus}</strong></div>
        </footer>
      </section>
    </main>
  )
}
