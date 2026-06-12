import { useEffect, useMemo, useRef, useState } from 'react'
import InhouseStrategyChart, { type InhouseSeries } from './InhouseStrategyChart'
import { apiPath } from './config'
import './strategy-chart.css'

type Exchange = 'NSE' | 'BSE' | 'MCX'
type ChartMode = 'rolling' | 'custom' | 'iv-skew' | 'rolling-iv' | 'live-iv'

type Session = {
  access_token: string
  user_name: string
  account_id: string
  environment: 'PROD' | 'UAT'
  device_id?: string
  is_demo?: boolean
}

type StrategyChartProps = {
  session: Session | null
  onBack: () => void
}

type OptionChainResponse = {
  expiry: string
  all_expiries: string[]
  atm: number
  current_price: number
  ce: OptionLeg[]
  pe: OptionLeg[]
}

type OptionLeg = {
  ref_id: number
  strike: number
  iv: number
  delta: number
}

type IvSkewMeta = {
  ceStrike: number
  peStrike: number
  ceIv: number
  peIv: number
  ceDelta: number
  peDelta: number
  ratio: number
}

type IvSkewResponse = {
  instrument: string
  exchange: Exchange
  expiry: string
  interval: string
  ce: {
    strike: number
    symbol: string
    ref_id: number
    iv: number
    delta: number
  }
  pe: {
    strike: number
    symbol: string
    ref_id: number
    iv: number
    delta: number
  }
  ratio: number
  points: RollingPoint[]
  message: string
}

type RollingIVLeg = {
  label: string
  strike: number
  symbol: string
  ref_id: number
  iv: number
  delta: number
  points: RollingPoint[]
}

type RollingIVResponse = {
  instrument: string
  exchange: Exchange
  expiry: string
  interval: string
  atm: RollingIVLeg
  ce_25: RollingIVLeg
  pe_25: RollingIVLeg
  ce_10: RollingIVLeg
  pe_10: RollingIVLeg
  spot: RollingPoint[]
  current_price: number
  message: string
}

type RollingPoint = {
  ts: number
  value: number
}

type StraddleSeries = {
  strike: number
  ce_strike?: number
  pe_strike?: number
  ce: string
  pe: string
  points: RollingPoint[]
  iv_points?: RollingPoint[]
  ce_iv_points?: RollingPoint[]
  pe_iv_points?: RollingPoint[]
}

type RollingStraddleResponse = {
  instrument: string
  exchange: Exchange
  expiry: string
  mode?: ChartMode
  source?: string
  atm: number
  interval: string
  strike_count: number
  start_date?: string
  end_date?: string
  rolling: RollingPoint[]
  rolling_iv?: RollingPoint[]
  rolling_ce_iv?: RollingPoint[]
  rolling_pe_iv?: RollingPoint[]
  spot: RollingPoint[]
  synthetic_future: RollingPoint[]
  straddles: StraddleSeries[]
  message: string
}

type LiveRollingStraddle = {
  type: 'rolling_straddle'
  received_at_ms: number
  premium: number
  selected_strike: number
  synthetic_strike: number
  synthetic_future: number
  current_price: number
  ce_iv?: number
  pe_iv?: number
  avg_iv?: number
}

type LiveSocketMessage = Partial<Omit<LiveRollingStraddle, 'type'>> & {
  type?: string
  error?: string
  payload?: unknown
}

const instrumentsByExchange: Record<Exchange, string[]> = {
  NSE: ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'],
  BSE: ['SENSEX', 'BANKEX'],
  MCX: ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER'],
}

const intervals = ['1m', '3m', '5m', '15m', '30m'] as const
const intervalSeconds: Record<(typeof intervals)[number], number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
}

function requestBody(session: Session, extra: Record<string, unknown>) {
  return JSON.stringify({
    session_token: session.access_token,
    device_id: session.device_id ?? 'Nubra-OSS-strategy-chart',
    environment: session.environment,
    ...extra,
  })
}

function formatPrice(value: number) {
  return value > 0 ? value.toFixed(2) : '--'
}

function formatExpiry(value: string) {
  if (!/^\d{8}$/.test(value)) return value || 'Expiry'
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function shiftDays(dateStr: string, delta: number) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

function mergePoints(older: RollingPoint[], newer: RollingPoint[]): RollingPoint[] {
  const seen = new Set(newer.map(p => p.ts))
  return [...older.filter(p => !seen.has(p.ts)), ...newer].sort((a, b) => a.ts - b.ts)
}

function parseStrike(value: string) {
  const strike = Number(value)
  return Number.isFinite(strike) && strike > 0 ? strike : 0
}

function formatStrike(value: number) {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)
}

function nearestStrike(strikes: number[], value: number) {
  if (strikes.length === 0 || value <= 0) return ''
  return formatStrike(strikes.reduce((best, strike) => (
    Math.abs(strike - value) < Math.abs(best - value) ? strike : best
  ), strikes[0]))
}

type ChartPoint = {
  time: number
  value: number
}

function toChartData(points: RollingPoint[]): ChartPoint[] {
  const byTime = new Map<number, number>()
  for (const point of points) {
    const seconds = Math.floor(point.ts / 1_000_000_000)
    if (seconds > 0 && point.value > 0) byTime.set(seconds, point.value)
  }
  return Array.from(byTime.entries())
    .sort(([a], [b]) => a - b)
    .map(([time, value]) => ({ time, value }))
}

function rustRealtimeUrl(session: Session, exchange: Exchange, instrument: string, expiry: string) {
  const params = new URLSearchParams({
    token: session.access_token,
    env: session.environment,
    exchange,
    instrument,
    expiry,
  })
  const baseUrl = String(import.meta.env.VITE_RUST_REALTIME_WS_BASE || 'ws://127.0.0.1:3003')
    .replace(/\/$/, '')
  return `${baseUrl}/ws/rolling-straddle?${params.toString()}`
}

function alignedValues(timestamps: number[], points: ChartPoint[]) {
  const byTime = new Map(points.map(point => [point.time, point.value]))
  return timestamps.map(time => byTime.get(time) ?? null)
}

function appendOrReplacePoint(points: RollingPoint[], timeSeconds: number, value: number) {
  if (!Number.isFinite(value) || value <= 0) return points
  const ts = timeSeconds * 1_000_000_000
  const next = points.filter(point => Math.floor(point.ts / 1_000_000_000) !== timeSeconds)
  next.push({ ts, value })
  return next.sort((a, b) => a.ts - b.ts)
}

function ivVolOfVol(points: RollingPoint[]) {
  const values = points
    .filter(point => Number.isFinite(point.value) && point.value > 0)
    .sort((a, b) => a.ts - b.ts)
    .map(point => point.value)
  if (values.length < 3) return 0

  const changes: number[] = []
  for (let i = 1; i < values.length; i += 1) {
    changes.push(values[i] - values[i - 1])
  }
  if (changes.length < 2) return 0

  const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length
  const variance = changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (changes.length - 1)
  return Math.sqrt(variance)
}

function ivVolOfVolSeries(points: RollingPoint[], windowSize = 20): RollingPoint[] {
  const sorted = points
    .filter(point => Number.isFinite(point.value) && point.value > 0)
    .sort((a, b) => a.ts - b.ts)
  if (sorted.length < 3) return []

  const out: RollingPoint[] = []
  for (let end = 2; end < sorted.length; end += 1) {
    const start = Math.max(0, end - windowSize + 1)
    const window = sorted.slice(start, end + 1)
    const value = ivVolOfVol(window)
    if (value > 0) out.push({ ts: sorted[end].ts, value })
  }
  return out
}

function formatIvVolOfVol(points: RollingPoint[]) {
  const value = ivVolOfVol(points)
  return value > 0 ? value.toFixed(2) : '--'
}

export default function StrategyChart({ session, onBack }: StrategyChartProps) {
  const liveBucketRef = useRef<number | null>(null)
  const [exchange, setExchange] = useState<Exchange>('NSE')
  const [instrument, setInstrument] = useState('NIFTY')
  const [expiry, setExpiry] = useState('')
  const [interval, setInterval] = useState<(typeof intervals)[number]>('5m')
  const [chartMode, setChartMode] = useState<ChartMode>('rolling')
  const [customCeStrike, setCustomCeStrike] = useState('')
  const [customPeStrike, setCustomPeStrike] = useState('')
  const [expiries, setExpiries] = useState<string[]>([])
  const [chainMeta, setChainMeta] = useState<OptionChainResponse | null>(null)
  const [chart, setChart] = useState<RollingStraddleResponse | null>(null)
  const [ivSkewPoints, setIvSkewPoints] = useState<RollingPoint[]>([])
  const [ivSkewMeta, setIvSkewMeta] = useState<IvSkewMeta | null>(null)
  const [rollingIVChart, setRollingIVChart] = useState<RollingIVResponse | null>(null)
  const [loadingExpiry, setLoadingExpiry] = useState(false)
  const [loadingChart, setLoadingChart] = useState(false)
  const [livePoint, setLivePoint] = useState<LiveRollingStraddle | null>(null)
  const [liveStatus, setLiveStatus] = useState('Offline')
  const [error, setError] = useState('')
  const [liveIvCe, setLiveIvCe] = useState<RollingPoint[]>([])
  const [liveIvPe, setLiveIvPe] = useState<RollingPoint[]>([])
  const [liveIvAvg, setLiveIvAvg] = useState<RollingPoint[]>([])
  const [oldestDate, setOldestDate] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [prependCount, setPrependCount] = useState(0)
  const rollingChartLoaded = (chartMode === 'rolling' || chartMode === 'live-iv') && Boolean(chart)

  useEffect(() => {
    const first = instrumentsByExchange[exchange][0]
    setInstrument(first)
    setExpiry('')
    setExpiries([])
    setChainMeta(null)
    setChart(null)
    setIvSkewPoints([])
    setIvSkewMeta(null)
    setRollingIVChart(null)
    setLivePoint(null)
    setLiveStatus('Offline')
  }, [exchange])

  useEffect(() => {
    setChart(null)
    setIvSkewPoints([])
    setIvSkewMeta(null)
    setRollingIVChart(null)
    setLivePoint(null)
    setLiveStatus('Offline')
    setError('')
    setLiveIvCe([])
    setLiveIvPe([])
    setLiveIvAvg([])
    setOldestDate(null)
    setLoadingMore(false)
    setPrependCount(0)
  }, [chartMode])

  useEffect(() => {
    if (!chainMeta || customCeStrike || customPeStrike) return
    const atm = chainMeta.atm > 0 ? chainMeta.atm.toFixed(0) : ''
    setCustomCeStrike(atm)
    setCustomPeStrike(atm)
  }, [chainMeta, customCeStrike, customPeStrike])

  useEffect(() => {
    if (!session || session.is_demo || !instrument) return
    let cancelled = false
    setLoadingExpiry(true)
    setError('')
    setChainMeta(null)

    fetch(apiPath('/api/market/option-chain'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(session, { exchange, instrument, ...(expiry ? { expiry } : {}) }),
    })
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail ?? 'Unable to load expiries.')
        return data as OptionChainResponse
      })
      .then(data => {
        if (cancelled) return
        const nextExpiries = data.all_expiries ?? []
        setChainMeta(data)
        setExpiries(nextExpiries)
        if (!expiry) setExpiry(data.expiry || nextExpiries[0] || '')
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load expiries.')
      })
      .finally(() => {
        if (!cancelled) setLoadingExpiry(false)
      })

    return () => { cancelled = true }
  }, [session, exchange, instrument, expiry])

  const ceStrikeOptions = Array.from(new Set((chainMeta?.ce ?? []).map(leg => leg.strike).filter(strike => strike > 0))).sort((a, b) => a - b)
  const peStrikeOptions = Array.from(new Set((chainMeta?.pe ?? []).map(leg => leg.strike).filter(strike => strike > 0))).sort((a, b) => a - b)

  useEffect(() => {
    if (!chainMeta || chartMode !== 'custom') return
    if (ceStrikeOptions.length > 0 && !ceStrikeOptions.some(strike => formatStrike(strike) === customCeStrike)) {
      setCustomCeStrike(nearestStrike(ceStrikeOptions, chainMeta.atm))
    }
    if (peStrikeOptions.length > 0 && !peStrikeOptions.some(strike => formatStrike(strike) === customPeStrike)) {
      setCustomPeStrike(nearestStrike(peStrikeOptions, chainMeta.atm))
    }
  }, [chainMeta, chartMode, ceStrikeOptions, peStrikeOptions, customCeStrike, customPeStrike])

  useEffect(() => {
    if (!session || session.is_demo || !instrument || !expiry) return
    const ceStrike = parseStrike(customCeStrike)
    const peStrike = parseStrike(customPeStrike)
    const isCustom = chartMode === 'custom'
    const isIvSkew = chartMode === 'iv-skew'
    const isRollingIV = chartMode === 'rolling-iv'
    if (isIvSkew || isRollingIV) {
      setChart(null)
      setLivePoint(null)
      setLiveStatus('Loaded')
      setLoadingChart(false)
      setError('')
      return
    }
    if (isCustom && (!ceStrike || !peStrike)) {
      setChart(null)
      setLivePoint(null)
      setLiveStatus('Offline')
      setError('')
      return
    }
    let cancelled = false
    setLoadingChart(true)
    setError('')
    setChart(null)
    setOldestDate(null)
    setPrependCount(0)
    setLivePoint(null)
    setLiveStatus(isCustom ? 'Loaded' : 'Connecting')

    fetch(apiPath('/api/market/rolling-straddle'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(session, {
        exchange,
        instrument,
        expiry,
        end_date: expiry,
        interval,
        mode: chartMode,
        ...(isCustom ? { ce_strike: ceStrike, pe_strike: peStrike } : {}),
        strike_count: 11,
      }),
    })
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail ?? 'Unable to load rolling straddle.')
        return data as RollingStraddleResponse
      })
      .then(data => {
        if (!cancelled) {
          setChart(data)
          if (data.start_date) setOldestDate(data.start_date)
          setPrependCount(0)
        }
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load rolling straddle.')
      })
      .finally(() => {
        if (!cancelled) setLoadingChart(false)
      })

    return () => { cancelled = true }
  }, [session, exchange, instrument, expiry, interval, chartMode, customCeStrike, customPeStrike])

  useEffect(() => {
    if (!session || session.is_demo || chartMode !== 'rolling-iv' || !instrument || !expiry) return
    let cancelled = false
    setLoadingChart(true)
    setError('')
    setChart(null)
    setIvSkewPoints([])
    setIvSkewMeta(null)
    setLivePoint(null)
    setLiveStatus('Loaded')
    fetch(apiPath('/api/market/rolling-iv'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(session, { exchange, instrument, expiry, interval }),
    })
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail ?? 'Unable to load rolling IV.')
        return data as RollingIVResponse
      })
      .then(data => {
        if (!cancelled) setRollingIVChart(data)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load rolling IV.')
      })
      .finally(() => {
        if (!cancelled) setLoadingChart(false)
      })
    return () => {
      cancelled = true
    }
  }, [session, exchange, instrument, expiry, interval, chartMode])

  useEffect(() => {
    if (!session || session.is_demo || chartMode !== 'iv-skew' || !instrument || !expiry) return
    let cancelled = false
    setLoadingChart(true)
    setError('')
    setChart(null)
    setLivePoint(null)
    setLiveStatus('Loaded')
    fetch(apiPath('/api/market/iv-skew'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(session, { exchange, instrument, expiry, interval }),
    })
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.detail ?? 'Unable to load IV skew.')
        return data as IvSkewResponse
      })
      .then(data => {
        if (cancelled) return
        setIvSkewPoints(data.points ?? [])
        setIvSkewMeta({
          ceStrike: data.ce.strike,
          peStrike: data.pe.strike,
          ceIv: data.ce.iv,
          peIv: data.pe.iv,
          ceDelta: data.ce.delta,
          peDelta: data.pe.delta,
          ratio: data.ratio,
        })
        setError('')
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load IV skew.')
      })
      .finally(() => {
        if (!cancelled) setLoadingChart(false)
      })
    return () => {
      cancelled = true
    }
  }, [session, exchange, instrument, expiry, interval, chartMode])

  function handleLeftEdge() {
    if (!session || session.is_demo || !instrument || !expiry) return
    if (chartMode !== 'rolling' && chartMode !== 'live-iv') return
    if (!oldestDate || loadingMore) return
    // Fetch 7 days back so each left-pan loads a full week
    const endDate = shiftDays(oldestDate, -1)
    const startDate = shiftDays(oldestDate, -8)
    setLoadingMore(true)
    fetch(apiPath('/api/market/rolling-straddle'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody(session, {
        exchange,
        instrument,
        expiry,
        start_date: startDate,
        end_date: endDate,
        interval,
        mode: 'rolling',
        strike_count: 11,
      }),
    })
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) return
        const older = data as RollingStraddleResponse
        if (!older.rolling?.length) return
        setChart(current => {
          if (!current) return current
          const newRolling = mergePoints(older.rolling, current.rolling)
          const prepended = newRolling.length - current.rolling.length
          if (prepended > 0) setPrependCount(prepended)
          return {
            ...current,
            rolling: newRolling,
            rolling_iv: mergePoints(older.rolling_iv ?? [], current.rolling_iv ?? []),
            rolling_ce_iv: mergePoints(older.rolling_ce_iv ?? [], current.rolling_ce_iv ?? []),
            rolling_pe_iv: mergePoints(older.rolling_pe_iv ?? [], current.rolling_pe_iv ?? []),
            spot: mergePoints(older.spot, current.spot),
            synthetic_future: mergePoints(older.synthetic_future, current.synthetic_future),
          }
        })
        if (older.start_date) setOldestDate(older.start_date)
      })
      .finally(() => setLoadingMore(false))
  }

  const inhouseChart = useMemo(() => {
    const rollingIvVolPoints = chartMode === 'rolling-iv'
      ? ivVolOfVolSeries(rollingIVChart?.atm.points ?? [])
      : chartMode === 'live-iv'
        ? ivVolOfVolSeries(liveIvAvg)
        : ivVolOfVolSeries(chart?.rolling_iv ?? [])
    const seriesPoints = chartMode === 'rolling-iv'
      ? [
          { label: 'ATM IV', points: toChartData(rollingIVChart?.atm.points ?? []), stroke: '#05b878', axisId: 'right' as const, width: 2 },
          { label: 'Vol of IV', points: toChartData(rollingIvVolPoints), stroke: '#ffffff', axisId: 'vol' as const, width: 2, dashed: true },
          { label: '25D Call IV', points: toChartData(rollingIVChart?.ce_25.points ?? []), stroke: '#f0b90b', axisId: 'right' as const, width: 2 },
          { label: '25D Put IV', points: toChartData(rollingIVChart?.pe_25.points ?? []), stroke: '#38bdf8', axisId: 'right' as const, width: 2 },
          { label: '10D Call IV', points: toChartData(rollingIVChart?.ce_10.points ?? []), stroke: '#fb7185', axisId: 'right' as const, width: 1 },
          { label: '10D Put IV', points: toChartData(rollingIVChart?.pe_10.points ?? []), stroke: '#c084fc', axisId: 'right' as const, width: 1 },
        ]
      : chartMode === 'iv-skew'
        ? [
            { label: '10D IV Skew', points: toChartData(ivSkewPoints), stroke: '#05b878', axisId: 'right' as const, width: 2 },
          ]
        : chartMode === 'live-iv'
          ? [
              { label: 'Avg IV', points: toChartData(liveIvAvg), stroke: '#05b878', axisId: 'right' as const, width: 2 },
              { label: 'Vol of IV', points: toChartData(rollingIvVolPoints), stroke: '#ffffff', axisId: 'vol' as const, width: 2, dashed: true },
              { label: 'CE IV', points: toChartData(liveIvCe), stroke: '#f0b90b', axisId: 'right' as const, width: 1 },
              { label: 'PE IV', points: toChartData(liveIvPe), stroke: '#38bdf8', axisId: 'right' as const, width: 1 },
              { label: 'Spot', points: toChartData(chart?.spot ?? []), stroke: '#a78bfa', axisId: 'left' as const, width: 1, dashed: true },
            ]
          : [
              { label: chartMode === 'custom' ? 'Custom Premium' : 'Rolling Premium', points: toChartData(chart?.rolling ?? []), stroke: '#05b878', axisId: 'right' as const, width: 2 },
              { label: 'Synthetic Future', points: toChartData(chart?.synthetic_future ?? []), stroke: '#f0b90b', axisId: 'left' as const, width: 2 },
              { label: 'Spot', points: toChartData(chart?.spot ?? []), stroke: '#38bdf8', axisId: 'left' as const, width: 1, dashed: true },
              { label: 'Rolling IV', points: toChartData(chart?.rolling_iv ?? []), stroke: '#a78bfa', axisId: 'iv' as const, width: 1 },
              { label: 'Vol of IV', points: toChartData(rollingIvVolPoints), stroke: '#ffffff', axisId: 'vol' as const, width: 2, dashed: true },
            ]

    const timestamps = Array.from(new Set(seriesPoints.flatMap(item => item.points.map(point => point.time)))).sort((a, b) => a - b)
    const alignedSeries: InhouseSeries[] = seriesPoints
      .filter(item => item.points.length > 0)
      .map(item => ({
        label: item.label,
        values: alignedValues(timestamps, item.points),
        stroke: item.stroke,
        axisId: item.axisId,
        width: item.width,
        dashed: item.dashed,
      }))
    liveBucketRef.current = timestamps.at(-1) ?? null
    return { timestamps, series: alignedSeries }
  }, [chart, chartMode, ivSkewPoints, rollingIVChart, liveIvCe, liveIvPe, liveIvAvg])

  useEffect(() => {
    if (!session || !instrument || !expiry || !rollingChartLoaded) return
    if (session.is_demo) {
      setLiveStatus('Demo only')
      return
    }
    setLiveIvCe([])
    setLiveIvPe([])
    setLiveIvAvg([])

    const socket = new WebSocket(rustRealtimeUrl(session, exchange, instrument, expiry))
    setLiveStatus('Connecting')

    socket.onopen = () => setLiveStatus('Bridge connected')
    socket.onclose = event => setLiveStatus(event.wasClean ? 'Closed' : 'Offline')
    socket.onerror = () => setLiveStatus('WS error')
    socket.onmessage = event => {
      let data: LiveSocketMessage
      try {
        data = JSON.parse(event.data) as LiveSocketMessage
      } catch {
        return
      }
      if (data.type === 'connected') {
        setLiveStatus('Nubra connected')
        return
      }
      if (data.type === 'upstream_error' || data.type === 'subscription_error') {
        setLiveStatus('Nubra error')
        setError(data.error || 'Nubra websocket connection failed.')
        return
      }
      if (data.type === 'decode_error') {
        setLiveStatus('Decode error')
        return
      }
      if (data.type === 'nubra_text') {
        setLiveStatus('Nubra message')
        return
      }
      if (data.type !== 'rolling_straddle') return
      if (!Number.isFinite(data.premium) || !Number.isFinite(data.received_at_ms)) return

      const point = data as LiveRollingStraddle
      setLiveStatus('Live')
      const seconds = Math.floor(point.received_at_ms / 1000)
      const bucketSize = intervalSeconds[interval]
      const bucketTime = Math.floor(seconds / bucketSize) * bucketSize
      const lastBucket = liveBucketRef.current
      const updateTime = lastBucket && bucketTime < lastBucket ? lastBucket : bucketTime

      liveBucketRef.current = updateTime
      setChart(current => current ? {
        ...current,
        rolling: appendOrReplacePoint(current.rolling, updateTime, point.premium),
        synthetic_future: appendOrReplacePoint(current.synthetic_future, updateTime, point.synthetic_future),
        spot: appendOrReplacePoint(current.spot, updateTime, point.current_price),
      } : current)
      if (Number.isFinite(point.ce_iv) && (point.ce_iv ?? 0) > 0)
        setLiveIvCe(prev => appendOrReplacePoint(prev, updateTime, point.ce_iv!))
      if (Number.isFinite(point.pe_iv) && (point.pe_iv ?? 0) > 0)
        setLiveIvPe(prev => appendOrReplacePoint(prev, updateTime, point.pe_iv!))
      if (Number.isFinite(point.avg_iv) && (point.avg_iv ?? 0) > 0)
        setLiveIvAvg(prev => appendOrReplacePoint(prev, updateTime, point.avg_iv!))
      setLivePoint(point)
      setChainMeta(current => current ? { ...current, current_price: point.current_price } : current)
    }

    return () => {
      socket.close()
    }
  }, [session, exchange, instrument, expiry, interval, rollingChartLoaded])

  const latestRolling = chartMode === 'rolling-iv'
    ? rollingIVChart?.atm.points.at(-1)?.value ?? 0
    : chartMode === 'iv-skew'
      ? ivSkewPoints.at(-1)?.value ?? 0
      : chartMode === 'live-iv'
        ? livePoint?.avg_iv ?? liveIvAvg.at(-1)?.value ?? 0
        : livePoint?.premium ?? chart?.rolling.at(-1)?.value ?? 0
  const hasChartData = chartMode === 'rolling-iv'
    ? (rollingIVChart?.atm.points.length ?? 0) > 0
    : chartMode === 'iv-skew'
      ? ivSkewPoints.length > 0
      : chartMode === 'live-iv'
        ? liveIvAvg.length > 0
        : (chart?.rolling.length ?? 0) > 0
  const chartTitle = chartMode === 'rolling-iv'
    ? 'Rolling IV'
    : chartMode === 'iv-skew'
      ? '10 delta IV skew'
      : chartMode === 'live-iv'
        ? 'Live ATM IV'
        : chartMode === 'custom'
          ? 'Custom straddle premium'
          : 'Rolling straddle premium'
  const emptyTitle = chartMode === 'rolling-iv'
    ? 'Waiting for Rolling IV'
    : chartMode === 'iv-skew'
      ? 'Waiting for 10 delta IV skew'
      : chartMode === 'live-iv'
        ? 'Waiting for live IV'
        : chartMode === 'custom'
          ? 'Enter CE and PE strike'
          : 'Select instrument and expiry'
  const chartLoadingText = chartMode === 'rolling-iv'
    ? 'Loading rolling IV...'
    : chartMode === 'iv-skew'
      ? 'Loading IV skew...'
      : chartMode === 'live-iv'
        ? 'Loading live IV...'
        : chartMode === 'custom'
          ? 'Loading custom straddle...'
          : 'Loading rolling straddle...'
  const chartStatusText = error || (
    session?.is_demo
      ? 'Login with a live Nubra session to load chart data.'
      : hasChartData
        ? ''
        : chartMode === 'rolling-iv'
          ? 'At every timestamp, spot and option prices select ATM, 25D CE/PE, and 10D CE/PE IV.'
          : chartMode === 'iv-skew'
            ? 'Tracks CE 0.10 delta IV divided by PE 0.10 delta IV from option-chain snapshots.'
            : chartMode === 'live-iv'
              ? 'Streams live CE/PE IV from the ATM strike selected by the rolling straddle.'
              : chartMode === 'custom'
                ? 'Enter CE and PE strikes to load the custom premium chart.'
                : 'Expiry loads first, then Rust streams live option-chain rolling straddle.'
  )
  const primaryMetric = chartMode === 'rolling-iv'
    ? latestRolling > 0 ? latestRolling.toFixed(2) : '--'
    : chartMode === 'iv-skew'
      ? latestRolling.toFixed(4)
      : chartMode === 'live-iv'
        ? latestRolling > 0 ? latestRolling.toFixed(2) : '--'
        : formatPrice(latestRolling)
  const latestRollingIv = chart?.rolling_iv?.at(-1)?.value ?? 0
  const latestRollingCeIv = chart?.rolling_ce_iv?.at(-1)?.value ?? 0
  const latestRollingPeIv = chart?.rolling_pe_iv?.at(-1)?.value ?? 0
  const rollingIVValue = (leg?: RollingIVLeg) => leg?.points.at(-1)?.value ? leg.points.at(-1)!.value.toFixed(2) : '--'
  const activeIvPoints = chartMode === 'rolling-iv'
    ? rollingIVChart?.atm.points ?? []
    : chartMode === 'live-iv'
      ? liveIvAvg
      : chart?.rolling_iv ?? []

  return (
    <main className="strategy-chart-shell">
      <section className="strategy-chart-container">
        <header className="strategy-chart-header">
          <div className="strategy-chart-heading">
            <span className="strategy-chart-kicker">Strategy Chart</span>
          </div>
          <div className="strategy-top-controls">
            <label className="strategy-control">
              <span>Chart</span>
              <select value={chartMode} onChange={event => setChartMode(event.target.value as ChartMode)}>
                <option value="rolling">Rolling Straddle</option>
                <option value="live-iv">Live IV</option>
                <option value="rolling-iv">Rolling IV</option>
                <option value="custom">Custom</option>
                <option value="iv-skew">IV Skew</option>
              </select>
            </label>
            <label className="strategy-control">
              <span>Exchange</span>
              <select value={exchange} onChange={event => setExchange(event.target.value as Exchange)}>
                {Object.keys(instrumentsByExchange).map(item => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label className="strategy-control">
              <span>Instrument</span>
              <select value={instrument} onChange={event => setInstrument(event.target.value)}>
                {instrumentsByExchange[exchange].map(item => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label className="strategy-control strategy-control-wide">
              <span>Expiry</span>
              <select value={expiry} onChange={event => setExpiry(event.target.value)} disabled={loadingExpiry || expiries.length === 0}>
                {expiries.length === 0 && <option value="">{loadingExpiry ? 'Loading...' : 'No expiry'}</option>}
                {expiries.map(item => <option key={item} value={item}>{formatExpiry(item)}</option>)}
              </select>
            </label>
            <label className="strategy-control">
              <span>Timeframe</span>
              <select value={interval} onChange={event => setInterval(event.target.value as (typeof intervals)[number])}>
                {intervals.map(item => <option key={item}>{item}</option>)}
              </select>
            </label>
            {chartMode === 'custom' && (
              <>
                <label className="strategy-control">
                  <span>Call strike</span>
                  <select
                    value={customCeStrike}
                    onChange={event => setCustomCeStrike(event.target.value)}
                    disabled={loadingExpiry || ceStrikeOptions.length === 0}
                  >
                    {ceStrikeOptions.length === 0 && <option value="">{loadingExpiry ? 'Loading...' : 'No CE strikes'}</option>}
                    {ceStrikeOptions.map(strike => {
                      const value = formatStrike(strike)
                      return <option key={value} value={value}>{value}</option>
                    })}
                  </select>
                </label>
                <label className="strategy-control">
                  <span>Put strike</span>
                  <select
                    value={customPeStrike}
                    onChange={event => setCustomPeStrike(event.target.value)}
                    disabled={loadingExpiry || peStrikeOptions.length === 0}
                  >
                    {peStrikeOptions.length === 0 && <option value="">{loadingExpiry ? 'Loading...' : 'No PE strikes'}</option>}
                    {peStrikeOptions.map(strike => {
                      const value = formatStrike(strike)
                      return <option key={value} value={value}>{value}</option>
                    })}
                  </select>
                </label>
              </>
            )}
            {chartMode === 'iv-skew' && (
              <div className="strategy-inline-summary">
                <span>CE 10D <strong>{ivSkewMeta ? `${formatStrike(ivSkewMeta.ceStrike)} / ${ivSkewMeta.ceIv.toFixed(2)}` : '--'}</strong></span>
                <span>PE 10D <strong>{ivSkewMeta ? `${formatStrike(ivSkewMeta.peStrike)} / ${ivSkewMeta.peIv.toFixed(2)}` : '--'}</strong></span>
              </div>
            )}
          </div>
          <button type="button" className="strategy-chart-back" onClick={onBack}>
            Back to Dashboard
          </button>
        </header>

        <div className="strategy-chart-grid">
          <section className="strategy-chart-stage">
            <div className="strategy-chart-canvas" aria-label="Rolling straddle chart">
              <InhouseStrategyChart
                title={chartTitle}
                value={primaryMetric}
                timestamps={inhouseChart.timestamps}
                series={inhouseChart.series}
                onLeftEdge={handleLeftEdge}
                prependCount={prependCount}
              />
              <div className={hasChartData ? 'strategy-chart-status top-left' : 'strategy-chart-empty'}>
                <strong>{loadingChart ? chartLoadingText : hasChartData ? `${instrument} ${expiry}` : emptyTitle}</strong>
                {chartStatusText && <span>{chartStatusText}</span>}
              </div>
              {loadingMore && (
                <div className="strategy-chart-loading-more">Loading older data...</div>
              )}
            </div>
          </section>
        </div>

        <footer className="strategy-stat-row">
          {chartMode === 'rolling-iv' ? (
            <>
              <div className="strategy-stat"><span>ATM IV</span><strong>{rollingIVValue(rollingIVChart?.atm)}</strong></div>
              <div className="strategy-stat"><span>Vol of IV</span><strong>{formatIvVolOfVol(activeIvPoints)}</strong></div>
              <div className="strategy-stat"><span>25D Call IV</span><strong>{rollingIVValue(rollingIVChart?.ce_25)}</strong></div>
              <div className="strategy-stat"><span>25D Put IV</span><strong>{rollingIVValue(rollingIVChart?.pe_25)}</strong></div>
              <div className="strategy-stat"><span>10D Call IV</span><strong>{rollingIVValue(rollingIVChart?.ce_10)}</strong></div>
              <div className="strategy-stat"><span>10D Put IV</span><strong>{rollingIVValue(rollingIVChart?.pe_10)}</strong></div>
            </>
          ) : chartMode === 'live-iv' ? (
            <>
              <div className="strategy-stat"><span>Avg IV</span><strong>{livePoint?.avg_iv ? livePoint.avg_iv.toFixed(2) : liveIvAvg.at(-1)?.value ? liveIvAvg.at(-1)!.value.toFixed(2) : '--'}</strong></div>
              <div className="strategy-stat"><span>Vol of IV</span><strong>{formatIvVolOfVol(activeIvPoints)}</strong></div>
              <div className="strategy-stat"><span>CE IV</span><strong>{livePoint?.ce_iv ? livePoint.ce_iv.toFixed(2) : liveIvCe.at(-1)?.value ? liveIvCe.at(-1)!.value.toFixed(2) : '--'}</strong></div>
              <div className="strategy-stat"><span>PE IV</span><strong>{livePoint?.pe_iv ? livePoint.pe_iv.toFixed(2) : liveIvPe.at(-1)?.value ? liveIvPe.at(-1)!.value.toFixed(2) : '--'}</strong></div>
              <div className="strategy-stat"><span>Strike</span><strong>{livePoint?.selected_strike ? livePoint.selected_strike.toFixed(0) : '--'}</strong></div>
              <div className="strategy-stat"><span>Status</span><strong>{loadingExpiry || loadingChart ? 'Loading' : error ? 'Error' : liveStatus}</strong></div>
            </>
          ) : (
            <>
              <div className="strategy-stat"><span>{chartMode === 'iv-skew' ? 'IV Skew' : chartMode === 'custom' ? 'Custom Premium' : 'Rolling Premium'}</span><strong>{primaryMetric}</strong></div>
              <div className="strategy-stat"><span>{chartMode === 'iv-skew' ? 'Current Price' : 'Rolling IV'}</span><strong>{chartMode === 'iv-skew' ? formatPrice(chainMeta?.current_price ?? 0) : latestRollingIv > 0 ? latestRollingIv.toFixed(2) : '--'}</strong></div>
              {chartMode !== 'iv-skew' && <div className="strategy-stat"><span>Vol of IV</span><strong>{formatIvVolOfVol(activeIvPoints)}</strong></div>}
              <div className="strategy-stat"><span>{chartMode === 'iv-skew' ? 'CE IV' : 'CE IV'}</span><strong>{chartMode === 'iv-skew' ? ivSkewMeta?.ceIv.toFixed(2) ?? '--' : latestRollingCeIv > 0 ? latestRollingCeIv.toFixed(2) : '--'}</strong></div>
              <div className="strategy-stat"><span>{chartMode === 'iv-skew' ? 'PE IV' : 'PE IV'}</span><strong>{chartMode === 'iv-skew' ? ivSkewMeta?.peIv.toFixed(2) ?? '--' : latestRollingPeIv > 0 ? latestRollingPeIv.toFixed(2) : '--'}</strong></div>
              <div className="strategy-stat"><span>Status</span><strong>{loadingExpiry || loadingChart ? 'Loading' : error ? 'Error' : liveStatus}</strong></div>
            </>
          )}
        </footer>
      </section>
    </main>
  )
}
