import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'

type Theme = 'dark' | 'light'
type Step = 'start' | 'otp' | 'totp' | 'mpin' | 'success'
type AuthMethod = 'otp' | 'totp'
type DeskTab = 'vol' | 'straddle'

interface Session {
  access_token: string
  user_name: string
  account_id: string
  environment: 'PROD' | 'UAT'
  device_id?: string
  is_demo?: boolean
}

type OptionLeg = {
  ref_id: number
  strike: number
  ltp: number
  ltp_chg: number
  iv: number
  delta: number
  gamma: number
  theta: number
  vega: number
  oi: number
  oi_chg: number
  volume: number
}

type OptionChainResponse = {
  instrument: string
  exchange: string
  expiry: string
  all_expiries: string[]
  atm: number
  current_price: number
  ce: OptionLeg[]
  pe: OptionLeg[]
  pcr: number
  total_ce_oi: number
  total_pe_oi: number
}

type OIChangePoint = {
  strike: number
  call: number
  put: number
}

type OIChangeResponse = {
  points: OIChangePoint[]
  message: string
}

type RollingPoint = {
  ts: number
  value: number
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
  atm: RollingIVLeg
  ce_25: RollingIVLeg
  pe_25: RollingIVLeg
  ce_10: RollingIVLeg
  pe_10: RollingIVLeg
  spot: RollingPoint[]
  current_price: number
  message: string
}

type RollingStraddleResponse = {
  instrument: string
  exchange: string
  expiry: string
  mode: string
  source?: string
  atm: number
  interval: string
  rolling: RollingPoint[]
  rolling_iv: RollingPoint[]
  rolling_ce_iv: RollingPoint[]
  rolling_pe_iv: RollingPoint[]
  spot: RollingPoint[]
  synthetic_future: RollingPoint[]
  straddles?: Array<{
    strike: number
    points: RollingPoint[]
  }>
  message: string
}

const SESSION_KEY = 'alpha-desk.session'
const API_BASE = ''
const LOT_SIZE: Record<string, number> = { NIFTY: 75, BANKNIFTY: 30, FINNIFTY: 40, MIDCPNIFTY: 120 }
const MARKET_OPEN_MINUTES = 9 * 60 + 15
const MARKET_CLOSE_MINUTES = 15 * 60 + 30

function loadSession(): Session | null {
  const raw = window.localStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Session
  } catch {
    return null
  }
}

function saveSession(session: Session) {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

function clearSession() {
  window.localStorage.removeItem(SESSION_KEY)
}

function inr(value: number, digits = 2) {
  if (!Number.isFinite(value)) return '--'
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
}

function compact(value: number, digits = 1) {
  if (!Number.isFinite(value)) return '--'
  const abs = Math.abs(value)
  if (abs >= 10000000) return `${(value / 10000000).toFixed(digits)} Cr`
  if (abs >= 100000) return `${(value / 100000).toFixed(digits)} L`
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits }).format(value)
}

function pct(value: number, digits = 2) {
  if (!Number.isFinite(value)) return '--'
  return `${value.toFixed(digits)}%`
}

function timestampMs(ts: number) {
  if (!Number.isFinite(ts) || ts <= 0) return null
  if (ts > 10_000_000_000_000_000) return Math.round(ts / 1_000_000)
  if (ts > 10_000_000_000_000) return Math.round(ts / 1_000)
  if (ts > 10_000_000_000) return Math.round(ts)
  return Math.round(ts * 1000)
}

function formatTime(ts: number) {
  const ms = timestampMs(ts)
  if (ms === null) return '--'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '--'
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  }).format(new Date(ms))
}

function formatExpiry(value: string) {
  if (!value) return 'Nearest'
  const compactDate = value.match(/^(\d{4})(\d{2})(\d{2})$/)
  const isoDate = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  const date = compactDate
    ? new Date(Number(compactDate[1]), Number(compactDate[2]) - 1, Number(compactDate[3]))
    : isoDate
      ? new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]))
      : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }).format(date)
}

function nearestLeg(legs: OptionLeg[], strike: number) {
  return legs.reduce<OptionLeg | null>((best, leg) => {
    if (!best) return leg
    return Math.abs(leg.strike - strike) < Math.abs(best.strike - strike) ? leg : best
  }, null)
}

function deltaLeg(legs: OptionLeg[], targetAbsDelta: number) {
  return legs
    .filter(leg => leg.iv > 0 && Number.isFinite(leg.delta))
    .reduce<OptionLeg | null>((best, leg) => {
      if (!best) return leg
      return Math.abs(Math.abs(leg.delta) - targetAbsDelta) < Math.abs(Math.abs(best.delta) - targetAbsDelta) ? leg : best
    }, null)
}

function pathFor(points: RollingPoint[], width: number, height: number, domain?: [number, number]) {
  const valid = points.filter(point => Number.isFinite(point.value) && timestampMs(point.ts) !== null)
  if (valid.length === 0) return ''
  const minX = Math.min(...valid.map(point => point.ts))
  const maxX = Math.max(...valid.map(point => point.ts))
  const minY = domain ? domain[0] : Math.min(...valid.map(point => point.value))
  const maxY = domain ? domain[1] : Math.max(...valid.map(point => point.value))
  const ySpan = Math.max(0.01, maxY - minY)
  const xSpan = Math.max(1, maxX - minX)
  return valid.map((point, index) => {
    const x = ((point.ts - minX) / xSpan) * width
    const y = height - ((point.value - minY) / ySpan) * height
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
}

function previousMarketDate(date: Date) {
  const next = new Date(date)
  next.setDate(next.getDate() - 1)
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() - 1)
  }
  return next
}

function marketDateTime(date: Date, minutes: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes, 0, 0)
}

function currentMarketWindow(minutesBack: number) {
  const now = new Date()
  const minuteNow = now.getHours() * 60 + now.getMinutes()
  const marketDate = minuteNow < MARKET_OPEN_MINUTES ? previousMarketDate(now) : now
  const endMinute = minuteNow < MARKET_OPEN_MINUTES
    ? MARKET_CLOSE_MINUTES
    : Math.min(MARKET_CLOSE_MINUTES, Math.max(MARKET_OPEN_MINUTES, Math.floor(minuteNow / 5) * 5))
  const startMinute = Math.max(MARKET_OPEN_MINUTES, endMinute - minutesBack)
  return [marketDateTime(marketDate, startMinute), marketDateTime(marketDate, endMinute)] as const
}

function AlphaLogo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="7" fill="url(#alphaDeskGrad)" />
      <path d="M7 22L16 6l9 16M11 17h10" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <defs>
        <linearGradient id="alphaDeskGrad" x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#10b981" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button className="theme-toggle" onClick={onToggle} aria-label="Toggle theme">
      <span className={`tt-track ${theme}`}><span className="tt-thumb" /></span>
    </button>
  )
}

function Sparkline({
  points,
  tone = 'neutral',
  domain,
  formatter = inr,
}: {
  points: RollingPoint[]
  tone?: 'neutral' | 'green' | 'red' | 'blue'
  domain?: [number, number]
  formatter?: (value: number) => string
}) {
  const validPoints = points.filter(point => Number.isFinite(point.value) && timestampMs(point.ts) !== null)
  const latest = validPoints.at(-1)
  const first = validPoints[0]
  const change = latest && first ? latest.value - first.value : 0
  return (
    <div className={`desk-spark ${tone}`}>
      <svg viewBox="0 0 260 92" preserveAspectRatio="none">
        <path d={pathFor(validPoints, 260, 92, domain)} />
      </svg>
      <div className="desk-spark-meta">
        <span>{first ? formatTime(first.ts) : '--'}</span>
        <strong className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '+' : ''}{formatter(change)}</strong>
        <span>{latest ? formatTime(latest.ts) : '--'}</span>
      </div>
    </div>
  )
}

function lowestPremiumSeries(series?: Array<{ points: RollingPoint[] }>) {
  const bestByTs = new Map<number, number>()
  for (const item of series ?? []) {
    for (const point of item.points ?? []) {
      if (!Number.isFinite(point.ts) || !Number.isFinite(point.value)) continue
      const current = bestByTs.get(point.ts)
      if (current == null || point.value < current) bestByTs.set(point.ts, point.value)
    }
  }
  return Array.from(bestByTs.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ts, value]) => ({ ts, value }))
}

function seriesStats(points?: RollingPoint[]) {
  const valid = (points ?? []).filter(point => Number.isFinite(point.value) && timestampMs(point.ts) !== null)
  const first = valid[0]
  const latest = valid.at(-1)
  const values = valid.map(point => point.value)
  return {
    first: first?.value,
    latest: latest?.value,
    min: values.length ? Math.min(...values) : undefined,
    max: values.length ? Math.max(...values) : undefined,
    change: first && latest ? latest.value - first.value : undefined,
  }
}

function BarStrip({ values }: { values: Array<{ label: string; value: number; tone: 'call' | 'put' | 'net' }> }) {
  const max = Math.max(1, ...values.map(item => Math.abs(item.value)))
  return (
    <div className="bar-strip">
      {values.map(item => (
        <div className="bar-row" key={item.label}>
          <span>{item.label}</span>
          <div><i className={item.tone} style={{ width: `${Math.max(4, Math.abs(item.value) / max * 100)}%` }} /></div>
          <strong>{compact(item.value)}</strong>
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const [theme, setTheme] = useState<Theme>('dark')
  const [session, setSession] = useState<Session | null>(() => loadSession())
  const [step, setStep] = useState<Step>('start')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('otp')
  const [phone, setPhone] = useState('')
  const [flowId, setFlowId] = useState('')
  const [message, setMessage] = useState('Enter your Nubra phone number.')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', ''])
  const [mpinDigits, setMpinDigits] = useState(['', '', '', ''])
  const [instrument, setInstrument] = useState('NIFTY')
  const [expiry, setExpiry] = useState('')
  const [tab, setTab] = useState<DeskTab>('vol')
  const [chain, setChain] = useState<OptionChainResponse | null>(null)
  const [chainError, setChainError] = useState('')
  const [chainLoading, setChainLoading] = useState(false)
  const [oiChange, setOiChange] = useState<OIChangePoint[]>([])
  const [rollingIV, setRollingIV] = useState<RollingIVResponse | null>(null)
  const [straddle, setStraddle] = useState<RollingStraddleResponse | null>(null)
  const [deskError, setDeskError] = useState('')
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])
  const mpinRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const authPayload = useMemo(() => {
    if (!session) return null
    return {
      session_token: session.access_token,
      device_id: session.device_id,
      environment: session.environment,
      exchange: 'NSE',
      instrument,
      expiry,
    }
  }, [session, instrument, expiry])

  useEffect(() => {
    if (!session) return
    const ctrl = new AbortController()
    setChainLoading(true)
    setChainError('')
    fetch(`${API_BASE}/api/market/option-chain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(authPayload),
    })
      .then(async res => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.detail ?? data?.message ?? 'Unable to load option chain.')
        return data as OptionChainResponse
      })
      .then(data => {
        setChain(data)
        setExpiry(current => current || data.expiry || data.all_expiries?.[0] || '')
      })
      .catch(err => {
        if (err?.name !== 'AbortError') {
          setChain(null)
          setChainError(err?.message ?? 'Unable to load option chain.')
        }
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setChainLoading(false)
      })
    return () => ctrl.abort()
  }, [session, authPayload])

  useEffect(() => {
    if (!session || !chain) return
    const ctrl = new AbortController()
    const spot = chain.current_price || chain.atm
    const strikes = Array.from(new Set([...chain.ce, ...chain.pe].map(leg => leg.strike)))
      .filter(strike => Math.abs((strike - spot) / spot) <= 0.06)
      .sort((a, b) => a - b)
    const [start, end] = currentMarketWindow(90)
    setDeskError('')
    setOiChange([])
    setRollingIV(null)
    setStraddle(null)

    const readJSON = async <T,>(res: Response, fallback: string): Promise<T> => {
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail ?? data?.message ?? fallback)
      return data as T
    }

    const oiRequest = fetch(`${API_BASE}/api/market/oi-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          ...authPayload,
          expiry: chain.expiry,
          strikes,
          start_time: start.toISOString(),
          end_time: end.toISOString(),
        }),
      }).then(res => readJSON<OIChangeResponse>(res, 'Unable to load OI change.'))

    const rollingIVRequest = fetch(`${API_BASE}/api/market/rolling-iv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ ...authPayload, expiry: chain.expiry, interval: '5m' }),
      }).then(res => readJSON<RollingIVResponse>(res, 'Unable to load rolling IV.'))

    const straddleRequest = fetch(`${API_BASE}/api/market/rolling-straddle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          ...authPayload,
          expiry: chain.expiry,
          end_date: chain.expiry,
          interval: '5m',
          mode: 'rolling',
          strike_count: 11,
        }),
      }).then(res => readJSON<RollingStraddleResponse>(res, 'Unable to load ATM straddle.'))

    Promise.allSettled([oiRequest, rollingIVRequest, straddleRequest])
      .then(results => {
        if (ctrl.signal.aborted) return
        const [oiResult, ivResult, straddleResult] = results
        if (oiResult.status === 'fulfilled') setOiChange(oiResult.value.points ?? [])
        if (ivResult.status === 'fulfilled') setRollingIV(ivResult.value)
        if (straddleResult.status === 'fulfilled') setStraddle(straddleResult.value)
        const hardFailure = results.every(result => result.status === 'rejected')
        setDeskError(hardFailure ? 'Historical analytics are unavailable right now. GEX and live option-chain data remain active.' : '')
      })
      .catch(err => {
        if (err?.name !== 'AbortError') setDeskError(err?.message ?? 'Unable to load desk analytics.')
      })

    return () => ctrl.abort()
  }, [session, chain, authPayload])

  function applySession(next: Session) {
    saveSession(next)
    setSession(next)
    setStep('success')
  }

  function signOut() {
    clearSession()
    setSession(null)
    setStep('start')
    setPhone('')
    setFlowId('')
    setOtpDigits(['', '', '', '', '', ''])
    setMpinDigits(['', '', '', ''])
    setMessage('Enter your Nubra phone number.')
    setError('')
  }

  async function handleStart(e: FormEvent) {
    e.preventDefault()
    if (!phone.trim()) {
      setError('Enter your phone number.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/auth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), auth_method: authMethod }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail ?? data?.message ?? 'Failed to start login.')
      setFlowId(data.flow_id ?? '')
      const nextStep = data.next_step === 'totp' ? 'totp' : 'otp'
      setStep(nextStep)
      setMessage(data.message ?? (nextStep === 'otp' ? 'OTP sent.' : 'Enter your TOTP code.'))
      setTimeout(() => otpRefs.current[0]?.focus(), 80)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to connect to backend.')
    } finally {
      setLoading(false)
    }
  }

  async function handleOtp(e: FormEvent) {
    e.preventDefault()
    const code = otpDigits.join('')
    if (code.length < 6) {
      setError('Enter the full 6-digit code.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const endpoint = authMethod === 'totp' ? '/api/auth/verify-totp' : '/api/auth/verify-otp'
      const body = authMethod === 'totp' ? { flow_id: flowId, totp: code } : { flow_id: flowId, otp: code }
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail ?? data?.message ?? 'Code verification failed.')
      setStep('mpin')
      setMessage(data.message ?? 'Enter your MPIN.')
      setTimeout(() => mpinRefs.current[0]?.focus(), 80)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handleMpin(e: FormEvent) {
    e.preventDefault()
    const pin = mpinDigits.join('')
    if (pin.length < 4) {
      setError('Enter your 4-digit MPIN.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/auth/verify-mpin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow_id: flowId, mpin: pin }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail ?? data?.message ?? 'MPIN verification failed.')
      applySession(data as Session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MPIN verification failed.')
    } finally {
      setLoading(false)
    }
  }

  function updateDigit(kind: 'otp' | 'mpin', index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1)
    if (kind === 'otp') {
      const next = [...otpDigits]
      next[index] = digit
      setOtpDigits(next)
      if (digit && index < 5) otpRefs.current[index + 1]?.focus()
    } else {
      const next = [...mpinDigits]
      next[index] = digit
      setMpinDigits(next)
      if (digit && index < 3) mpinRefs.current[index + 1]?.focus()
    }
  }

  const spot = chain?.current_price || chain?.atm || 0
  const ceByStrike = useMemo(() => new Map((chain?.ce ?? []).map(leg => [leg.strike, leg])), [chain])
  const peByStrike = useMemo(() => new Map((chain?.pe ?? []).map(leg => [leg.strike, leg])), [chain])
  const strikes = useMemo(() => Array.from(new Set([...(chain?.ce ?? []), ...(chain?.pe ?? [])].map(leg => leg.strike))).sort((a, b) => a - b), [chain])
  const visibleStrikes = strikes.filter(strike => !spot || Math.abs((strike - spot) / spot) <= 0.055)
  const lotSize = LOT_SIZE[instrument] ?? 1
  const atmStrike = visibleStrikes.reduce((best, strike) => Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best, visibleStrikes[0] ?? 0)
  const atmCE = nearestLeg(chain?.ce ?? [], atmStrike)
  const atmPE = nearestLeg(chain?.pe ?? [], atmStrike)
  const ce10 = deltaLeg(chain?.ce ?? [], 0.10)
  const pe10 = deltaLeg(chain?.pe ?? [], 0.10)
  const ce25 = deltaLeg(chain?.ce ?? [], 0.25)
  const pe25 = deltaLeg(chain?.pe ?? [], 0.25)
  const straddleNow = atmCE && atmPE ? atmCE.ltp + atmPE.ltp : 0
  const syntheticNow = atmCE && atmPE ? atmStrike + atmCE.ltp - atmPE.ltp : 0
  const intradayStraddlePoints = straddle?.rolling?.length ? straddle.rolling : lowestPremiumSeries(straddle?.straddles)
  const syntheticFuturePoints = straddle?.synthetic_future ?? []
  const netIvSkew10 = ce10 && pe10 ? ce10.iv - pe10.iv : 0
  const volLegs = [
    { label: 'ATM', leg: rollingIV?.atm, tone: 'neutral' as const },
    { label: '25D CE', leg: rollingIV?.ce_25, tone: 'green' as const },
    { label: '25D PE', leg: rollingIV?.pe_25, tone: 'red' as const },
    { label: '10D CE', leg: rollingIV?.ce_10, tone: 'green' as const },
    { label: '10D PE', leg: rollingIV?.pe_10, tone: 'red' as const },
  ]
  const volValues = volLegs.flatMap(item => (item.leg?.points ?? []).map(point => point.value).filter(Number.isFinite))
  const volDomain: [number, number] | undefined = volValues.length
    ? [Math.floor(Math.min(...volValues) * 2) / 2, Math.ceil(Math.max(...volValues) * 2) / 2]
    : undefined
  const gexRows = visibleStrikes.map(strike => {
    const ce = ceByStrike.get(strike)
    const pe = peByStrike.get(strike)
    const scale = spot > 0 ? lotSize * spot * spot * 0.01 / 10000000 : 0
    const call = (ce?.gamma ?? 0) * (ce?.oi ?? 0) * scale
    const put = -(pe?.gamma ?? 0) * (pe?.oi ?? 0) * scale
    return { strike, call, put, net: call + put, total: Math.abs(call) + Math.abs(put) }
  }).sort((a, b) => b.total - a.total)
  const wall = gexRows[0]
  const zeroGamma = gexRows.slice().sort((a, b) => Math.abs(a.net) - Math.abs(b.net))[0]
  const chainOIRows = visibleStrikes.map(strike => ({
    strike,
    call: (ceByStrike.get(strike)?.oi_chg ?? 0) / 100000,
    put: (peByStrike.get(strike)?.oi_chg ?? 0) / 100000,
  }))
  const nonZeroHistoryOIRows = oiChange.filter(row => Math.abs(row.call) + Math.abs(row.put) > 0.005)
  const oiRowsSource = nonZeroHistoryOIRows.length ? nonZeroHistoryOIRows : chainOIRows
  const oiRows = oiRowsSource
    .slice()
    .sort((a, b) => Math.abs(b.call) + Math.abs(b.put) - Math.abs(a.call) - Math.abs(a.put))
    .slice(0, 10)

  if (!session) {
    return (
      <div className="auth-scene desk-auth">
        <div className="auth-bg"><div className="grid-pattern" /></div>
        <header className="auth-chrome">
          <div className="logo"><AlphaLogo /><span className="wm">Alpha Desk</span></div>
          <ThemeToggle theme={theme} onToggle={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} />
        </header>
        <main className="auth-stage">
          <section className="glass-panel desk-login-panel">
            <div className="panel-head">
              <div className="eyebrow"><span className="eyebrow-dot" />Nubra Login</div>
              <h1>Trading Desk</h1>
              <p>{message}</p>
            </div>

            {step === 'start' && (
              <form onSubmit={handleStart} className="desk-form">
                <div className="seg-control" role="tablist" aria-label="Auth method">
                  <span className={`seg-pill ${authMethod === 'totp' ? 'right' : ''}`} />
                  <button type="button" className={authMethod === 'otp' ? 'active' : ''} onClick={() => setAuthMethod('otp')}>OTP</button>
                  <button type="button" className={authMethod === 'totp' ? 'active' : ''} onClick={() => setAuthMethod('totp')}>TOTP</button>
                </div>
                <label className="field-label">Phone</label>
                <input className="desk-input" value={phone} onChange={event => setPhone(event.target.value)} placeholder="Registered mobile number" />
                <button className="primary-btn" disabled={loading}>{loading ? 'Starting...' : 'Continue'}</button>
              </form>
            )}

            {(step === 'otp' || step === 'totp') && (
              <form onSubmit={handleOtp} className="desk-form">
                <label className="field-label">{step === 'otp' ? 'SMS OTP' : 'TOTP'}</label>
                <div className="digit-row">
                  {otpDigits.map((digit, index) => (
                    <input
                      key={index}
                      ref={el => { otpRefs.current[index] = el }}
                      value={digit}
                      onChange={event => updateDigit('otp', index, event.target.value)}
                      maxLength={1}
                      inputMode="numeric"
                    />
                  ))}
                </div>
                <button className="primary-btn" disabled={loading}>{loading ? 'Verifying...' : 'Verify'}</button>
              </form>
            )}

            {step === 'mpin' && (
              <form onSubmit={handleMpin} className="desk-form">
                <label className="field-label">MPIN</label>
                <div className="digit-row mpin-row">
                  {mpinDigits.map((digit, index) => (
                    <input
                      key={index}
                      ref={el => { mpinRefs.current[index] = el }}
                      value={digit}
                      onChange={event => updateDigit('mpin', index, event.target.value)}
                      maxLength={1}
                      inputMode="numeric"
                      type="password"
                    />
                  ))}
                </div>
                <button className="primary-btn" disabled={loading}>{loading ? 'Opening...' : 'Open Desk'}</button>
              </form>
            )}

            {error && <div className="auth-error">{error}</div>}
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="desk-shell">
      <header className="desk-top">
        <div className="logo"><AlphaLogo /><span className="wm">Alpha Desk</span></div>
        <div className="desk-controls">
          <select value={instrument} onChange={event => { setInstrument(event.target.value); setExpiry('') }} aria-label="Instrument">
            <option value="NIFTY">NIFTY</option>
            <option value="BANKNIFTY">BANKNIFTY</option>
            <option value="FINNIFTY">FINNIFTY</option>
            <option value="MIDCPNIFTY">MIDCPNIFTY</option>
          </select>
          <select value={expiry || chain?.expiry || ''} onChange={event => setExpiry(event.target.value)} aria-label="Expiry">
            {(chain?.all_expiries?.length ? chain.all_expiries : [chain?.expiry].filter(Boolean) as string[]).map(item => (
              <option key={item} value={item}>{formatExpiry(item)}</option>
            ))}
          </select>
          <ThemeToggle theme={theme} onToggle={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} />
          <button className="desk-icon-btn" onClick={signOut} aria-label="Sign out">Out</button>
        </div>
      </header>

      <main className="desk-main">
        <section className="desk-hero">
          <div>
            <span className="desk-kicker">{session.environment} / {session.account_id}</span>
            <h1>{instrument} Options Desk</h1>
          </div>
          <div className="desk-tape">
            <span><small>Spot</small><strong>{inr(spot)}</strong></span>
            <span><small>ATM</small><strong>{inr(atmStrike, 0)}</strong></span>
            <span><small>PCR</small><strong>{chain ? chain.pcr.toFixed(2) : '--'}</strong></span>
            <span><small>10D Skew</small><strong className={netIvSkew10 >= 0 ? 'up' : 'down'}>{netIvSkew10 >= 0 ? '+' : ''}{pct(netIvSkew10)}</strong></span>
          </div>
        </section>

        {(chainError || deskError) && <div className="desk-alert">{chainError || deskError}</div>}

        <section className="desk-grid">
          <article className="desk-card span-2">
            <div className="desk-card-head">
              <div><span>GEX Wall</span><strong>{wall ? inr(wall.strike, 0) : '--'}</strong></div>
              <small>{chainLoading ? 'Loading' : chain?.expiry ? formatExpiry(chain.expiry) : 'Waiting'}</small>
            </div>
            <div className="gex-chart">
              {gexRows.slice(0, 18).sort((a, b) => a.strike - b.strike).map(row => {
                const max = Math.max(1, ...gexRows.map(item => Math.abs(item.net)))
                const width = Math.max(3, Math.abs(row.net) / max * 48)
                return (
                  <div className="gex-row" key={row.strike}>
                    <span>{inr(row.strike, 0)}</span>
                    <i className="put" style={{ width: row.net < 0 ? `${width}%` : '0%' }} />
                    <b />
                    <i className="call" style={{ width: row.net >= 0 ? `${width}%` : '0%' }} />
                    <strong className={row.net >= 0 ? 'up' : 'down'}>{compact(row.net)}</strong>
                  </div>
                )
              })}
            </div>
          </article>

          <article className="desk-card span-2">
            <div className="desk-card-head">
              <div><span>OI Change</span><strong>{oiRows.length ? `${oiRows.length} strikes` : '--'}</strong></div>
              <small>{chainLoading ? 'Loading' : nonZeroHistoryOIRows.length ? 'Historical' : 'Chain oi_chg'}</small>
            </div>
            <div className="desk-table oi-table">
              <div className="desk-table-head">
                <span>Strike</span>
                <strong>Call OI</strong>
                <strong>Put OI</strong>
              </div>
              {oiRows.length ? oiRows.map(row => (
                <div key={row.strike}>
                  <span>{inr(row.strike, 0)}</span>
                  <strong className={row.call >= 0 ? 'up' : 'down'}>{row.call.toFixed(2)} L</strong>
                  <strong className={row.put >= 0 ? 'up' : 'down'}>{row.put.toFixed(2)} L</strong>
                </div>
              )) : (
                <div>
                  <span>Waiting</span>
                  <strong>--</strong>
                  <strong>--</strong>
                </div>
              )}
            </div>
          </article>

          <article className="desk-card">
            <div className="desk-card-head"><div><span>Gamma Levels</span><strong>{zeroGamma ? inr(zeroGamma.strike, 0) : '--'}</strong></div></div>
            <BarStrip values={[
              { label: 'Call GEX', value: gexRows.reduce((sum, row) => sum + row.call, 0), tone: 'call' },
              { label: 'Put GEX', value: gexRows.reduce((sum, row) => sum + row.put, 0), tone: 'put' },
              { label: 'Net GEX', value: gexRows.reduce((sum, row) => sum + row.net, 0), tone: 'net' },
            ]} />
          </article>

          <article className="desk-card">
            <div className="desk-card-head"><div><span>ATM Straddle</span><strong>{straddleNow ? inr(straddleNow) : '--'}</strong></div></div>
            <div className="metric-stack">
              <span><small>Synthetic Future</small><strong>{syntheticNow ? inr(syntheticNow) : '--'}</strong></span>
              <span><small>CE</small><strong>{atmCE ? inr(atmCE.ltp) : '--'}</strong></span>
              <span><small>PE</small><strong>{atmPE ? inr(atmPE.ltp) : '--'}</strong></span>
            </div>
          </article>

          <article className="desk-card span-2">
            <div className="desk-card-head">
              <div><span>Intraday Straddle</span><strong>{intradayStraddlePoints.at(-1) ? inr(intradayStraddlePoints.at(-1)!.value) : '--'}</strong></div>
              <small>{straddle?.source ?? 'Nubra'}</small>
            </div>
            <Sparkline points={intradayStraddlePoints} tone="green" />
          </article>

          <article className="desk-card span-2">
            <div className="desk-card-head">
              <div><span>Synthetic Future</span><strong>{syntheticFuturePoints.at(-1) ? inr(syntheticFuturePoints.at(-1)!.value) : '--'}</strong></div>
            </div>
            <Sparkline points={syntheticFuturePoints} tone="blue" />
          </article>

          <article className="desk-card span-2">
            <div className="desk-tabs">
              {([
                ['vol', 'Vol'],
                ['straddle', 'Structure'],
              ] as const).map(item => (
                <button key={item[0]} className={tab === item[0] ? 'active' : ''} onClick={() => setTab(item[0])}>{item[1]}</button>
              ))}
            </div>
            {tab === 'vol' && (
              <div className="vol-grid">
                {volLegs.map(({ label, leg, tone }) => {
                  const stats = seriesStats(leg?.points)
                  return (
                    <div key={label} className="vol-tile">
                      <span>{label}</span>
                      <strong>{leg ? pct(leg.iv) : '--'}</strong>
                      <small>{leg?.strike ? inr(leg.strike, 0) : '--'} / {leg?.delta ? leg.delta.toFixed(2) : '--'}</small>
                      <Sparkline points={leg?.points ?? []} tone={tone} domain={volDomain} formatter={value => value.toFixed(2)} />
                      <div className="vol-range">
                        <span>{stats.first != null ? pct(stats.first) : '--'} open</span>
                        <strong className={(stats.change ?? 0) >= 0 ? 'up' : 'down'}>{stats.change != null ? `${stats.change >= 0 ? '+' : ''}${stats.change.toFixed(2)} pts` : '--'}</strong>
                        <span>{stats.min != null && stats.max != null ? `${pct(stats.min)}-${pct(stats.max)}` : '--'}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {tab === 'straddle' && (
              <div className="metric-stack wide">
                <span><small>Rolling IV</small><strong>{straddle?.rolling_iv.at(-1) ? pct(straddle.rolling_iv.at(-1)!.value) : '--'}</strong></span>
                <span><small>CE 10D</small><strong>{ce10 ? `${inr(ce10.strike, 0)} / ${pct(ce10.iv)}` : '--'}</strong></span>
                <span><small>PE 10D</small><strong>{pe10 ? `${inr(pe10.strike, 0)} / ${pct(pe10.iv)}` : '--'}</strong></span>
                <span><small>CE 25D</small><strong>{ce25 ? `${inr(ce25.strike, 0)} / ${pct(ce25.iv)}` : '--'}</strong></span>
                <span><small>PE 25D</small><strong>{pe25 ? `${inr(pe25.strike, 0)} / ${pct(pe25.iv)}` : '--'}</strong></span>
              </div>
            )}
          </article>
        </section>
      </main>
    </div>
  )
}
