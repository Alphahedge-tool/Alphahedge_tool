import { useEffect, useMemo, useRef, useState } from 'react'
import Plotly from 'plotly.js-dist-min'

type JournalPayload = {
  columns: string[]
  rows: JournalRow[]
  meta?: {
    updatedAt?: string | null
    fileName?: string
    rows?: number
    uploadDate?: string | null
    date?: string
    loadedDate?: string
    missing?: boolean
    dates?: string[]
    allDates?: boolean
  }
}

type JournalRow = Record<string, string>
type ActiveTab = 'chart' | 'analysis' | 'cumPnl' | 'tradeLogs' | 'rows'
type ChartPoint = { time: number; value: number }
type SpotIvPoint = { time: number; rawTime: string; spot: number | null; avgIv: number | null }

const chartPalette = [
  '#38bdf8',
  '#f0b90b',
  '#f97316',
  '#a78bfa',
  '#ec4899',
  '#14b8a6',
  '#eab308',
  '#60a5fa',
  '#f87171',
  '#c084fc',
  '#43a047',
  '#22c55e',
]

type JournalProps = {
  onBack: () => void
}

const monthNames: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
}

function isNumeric(value: unknown) {
  if (value === null || value === undefined || value === '') return false
  return Number.isFinite(Number(String(value).replace(/,/g, '')))
}

function asNumber(value: unknown) {
  return Number(String(value || 0).replace(/,/g, ''))
}

function parseTimestamp(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return null

  const named = raw.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (named) {
    const [, day, monthName, rawYear, hour = '0', minute = '0', second = '0'] = named
    const month = monthNames[monthName.toLowerCase()]
    if (month !== undefined) {
      const year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear)
      return new Date(year, month, Number(day), Number(hour), Number(minute), Number(second)).getTime()
    }
  }

  const indian = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (indian) {
    const [, day, month, rawYear, hour = '0', minute = '0', second = '0'] = indian
    const year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear)
    return new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime()
  }

  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

function formatMoney(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '--'
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value)
}

function formatCell(value: string) {
  return isNumeric(value) ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(asNumber(value)) : value
}

function numericRange(rows: JournalRow[], column: string) {
  let high: number | null = null
  let low: number | null = null
  for (const row of rows) {
    if (!isNumeric(row[column])) continue
    const value = asNumber(row[column])
    high = high === null || value > high ? value : high
    low = low === null || value < low ? value : low
  }
  return { high, low }
}

function pickColumn(columns: string[], rows: JournalRow[], patterns: RegExp[]) {
  return columns.find(column => patterns.some(pattern => pattern.test(column.trim())))
    ?? columns.find(column => patterns.some(pattern => pattern.test(column)))
    ?? columns.find(column => rows.some(row => patterns.some(pattern => pattern.test(String(row[column])))))
    ?? ''
}

function latestRowsByStrategy(rows: JournalRow[], strategyCol: string, timeCol: string) {
  const map = new Map<string, JournalRow>()
  for (const row of rows) {
    const strategy = String(row[strategyCol] || '').trim()
    if (!strategy || strategy.toUpperCase() === 'ALL') continue
    const current = map.get(strategy)
    if (!current) {
      map.set(strategy, row)
      continue
    }
    const nextTime = parseTimestamp(row[timeCol]) ?? 0
    const currentTime = parseTimestamp(current[timeCol]) ?? 0
    if (nextTime >= currentTime) map.set(strategy, row)
  }
  return map
}

function numericPoints(rows: JournalRow[], mtmCol: string, timeCol: string) {
  return rows
    .map(row => {
      const timestamp = parseTimestamp(row[timeCol])
      if (!timestamp || !isNumeric(row[mtmCol])) return null
      return {
        timestamp,
        time: Math.floor(timestamp / 1000),
        value: asNumber(row[mtmCol]),
        rawTime: String(row[timeCol] || ''),
      }
    })
    .filter((point): point is { timestamp: number; time: number; value: number; rawTime: string } => Boolean(point))
    .sort((a, b) => a.timestamp - b.timestamp)
}

function uniquedLineData(points: ChartPoint[]) {
  const seen = new Map<number, number>()
  return points.map(point => {
    const time = Number(point.time)
    const count = seen.get(time) ?? 0
    seen.set(time, count + 1)
    return { ...point, time: time + count }
  })
}

function chartColor(strategy: string) {
  let hash = 0
  for (let i = 0; i < strategy.length; i += 1) {
    hash = ((hash << 5) - hash + strategy.charCodeAt(i)) | 0
  }
  return chartPalette[Math.abs(hash) % chartPalette.length]
}

function worstDrawdown(points: Array<{ value: number; rawTime: string }>) {
  if (!points.length) return null
  let peak = points[0]
  let worst = { peak, low: points[0], dip: 0 }
  for (const point of points) {
    if (point.value > peak.value) peak = point
    const dip = peak.value - point.value
    if (dip > worst.dip) worst = { peak, low: point, dip }
  }
  return worst
}

function firstNegative(points: Array<{ value: number; rawTime: string }>) {
  return points.find(point => point.value < 0) ?? null
}

function eventClass(value: unknown) {
  return `event-${String(value || 'message').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'message'}`
}

function logColumns(columns: string[]) {
  const preferred = ['Timestamp', 'Event', 'Strategy Tag', 'Option Portfolio', 'Details', 'Message']
  const realColumns = preferred.filter(column => column === 'Details' || columns.includes(column))
  return realColumns.length ? realColumns : columns.slice(0, 8)
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
    reader.onerror = () => reject(reader.error || new Error('Unable to read file.'))
    reader.readAsDataURL(file)
  })
}

export default function Journal({ onBack }: JournalProps) {
  const chartHostRef = useRef<HTMLDivElement | null>(null)
  const [payload, setPayload] = useState<JournalPayload>({ columns: [], rows: [] })
  const [tradeLogs, setTradeLogs] = useState<JournalPayload>({ columns: [], rows: [] })
  const [spotIv, setSpotIv] = useState<JournalPayload>({ columns: [], rows: [] })
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [query, setQuery] = useState('')
  const [selectedStrategy, setSelectedStrategy] = useState('all')
  const [activeTab, setActiveTab] = useState<ActiveTab>('chart')
  const [status, setStatus] = useState('Loading journal...')
  const [error, setError] = useState('')
  const isAllDatesMode = activeTab === 'cumPnl'

  const columns = payload.columns
  const rows = payload.rows
  const mtmCol = useMemo(() => pickColumn(columns, rows, [/^mtm$/i, /p&l/i, /pnl/i, /profit/i, /loss/i, /net/i]), [columns, rows])
  const strategyCol = useMemo(() => pickColumn(columns, rows, [/^name$/i, /strategy/i, /symbol/i]), [columns, rows])
  const timeCol = useMemo(() => pickColumn(columns, rows, [/^time$/i, /timestamp/i, /datetime/i, /date/i]), [columns, rows])
  const strategies = useMemo(() => {
    if (!strategyCol) return []
    return [...new Set(rows.map(row => String(row[strategyCol] || '').trim()).filter(Boolean))]
      .filter(name => name.toUpperCase() !== 'ALL')
      .sort()
  }, [rows, strategyCol])

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(row => {
      const strategyOk = selectedStrategy === 'all' || String(row[strategyCol] || '').trim() === selectedStrategy
      const queryOk = !q || columns.some(column => String(row[column] ?? '').toLowerCase().includes(q))
      return strategyOk && queryOk
    })
  }, [rows, columns, query, selectedStrategy, strategyCol])

  const selectedPoints = useMemo(() => {
    if (!mtmCol || !timeCol) return []
    return numericPoints(visibleRows, mtmCol, timeCol)
  }, [visibleRows, mtmCol, timeCol])

  const chartData = useMemo<ChartPoint[]>(() => {
    if (!mtmCol || !timeCol) return []
    if (activeTab === 'cumPnl') {
      let cumulative = 0
      return uniquedLineData(selectedPoints.map(point => {
        cumulative += point.value
        return { time: point.time, value: cumulative }
      }))
    }
    return uniquedLineData(selectedPoints)
  }, [activeTab, mtmCol, timeCol, selectedPoints])

  const chartTraces = useMemo(() => {
    if (!mtmCol || !timeCol || !strategyCol) {
      return [{
        strategy: selectedStrategy === 'all' ? 'All strategies' : selectedStrategy,
        color: chartColor(selectedStrategy === 'all' ? 'All strategies' : selectedStrategy),
        points: chartData,
      }]
    }

    const groups = new Map<string, JournalRow[]>()
    for (const row of visibleRows) {
      const strategy = String(row[strategyCol] || 'Unknown').trim() || 'Unknown'
      groups.set(strategy, [...(groups.get(strategy) || []), row])
    }

    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([strategy, strategyRows]) => {
        const color = chartColor(strategy)
        const points = numericPoints(strategyRows, mtmCol, timeCol)
        if (activeTab === 'cumPnl') {
          let cumulative = 0
          return {
            strategy,
            color,
            points: uniquedLineData(points.map(point => {
              cumulative += point.value
              return { time: point.time, value: cumulative }
            })),
          }
        }
        return {
          strategy,
          color,
          points: uniquedLineData(points),
        }
      })
      .filter(trace => trace.points.length)
  }, [activeTab, chartData, mtmCol, selectedStrategy, strategies, strategyCol, timeCol, visibleRows])

  const metrics = useMemo(() => {
    const numericRows = rows.filter(row => mtmCol && isNumeric(row[mtmCol]))
    const latest = strategyCol && timeCol ? latestRowsByStrategy(numericRows, strategyCol, timeCol) : new Map()
    const total = latest.size
      ? [...latest.values()].reduce((sum, row) => sum + asNumber(row[mtmCol]), 0)
      : numericRows.at(-1) ? asNumber(numericRows.at(-1)?.[mtmCol]) : null
    const range = mtmCol ? numericRange(numericRows, mtmCol) : { high: null, low: null }
    const points = mtmCol && timeCol ? numericPoints(visibleRows, mtmCol, timeCol) : []
    const dd = worstDrawdown(points)
    return { total, high: range.high, low: range.low, rows: rows.length, strategies: strategies.length, visible: visibleRows.length, drawdown: dd?.dip ?? null }
  }, [rows, visibleRows, mtmCol, strategyCol, timeCol, strategies.length])

  const selectedSummary = useMemo(() => {
    const points = selectedPoints
    const entry = points[0] ?? null
    const latest = points.at(-1) ?? null
    const high = points.length ? points.reduce((best, point) => point.value > best.value ? point : best, points[0]) : null
    const low = points.length ? points.reduce((best, point) => point.value < best.value ? point : best, points[0]) : null
    const dd = worstDrawdown(points)
    return { entry, latest, high, low, drawdown: dd, negative: firstNegative(points) }
  }, [selectedPoints])

  const analysisRows = useMemo(() => {
    if (!strategyCol || !mtmCol || !timeCol) return []
    return strategies.map(strategy => {
      const strategyRows = rows.filter(row => String(row[strategyCol] || '').trim() === strategy)
      const points = numericPoints(strategyRows, mtmCol, timeCol)
      const entry = points[0] ?? null
      const latest = points.at(-1) ?? null
      const high = points.length ? points.reduce((best, point) => point.value > best.value ? point : best, points[0]) : null
      const low = points.length ? points.reduce((best, point) => point.value < best.value ? point : best, points[0]) : null
      const dd = worstDrawdown(points)
      return { strategy, points: points.length, entry, latest, high, low, drawdown: dd, negative: firstNegative(points) }
    })
  }, [rows, strategies, strategyCol, mtmCol, timeCol])

  const tradeLogRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tradeLogs.rows.filter(row => {
      const strategyOk = selectedStrategy === 'all'
        || Object.values(row).some(value => String(value).trim() === selectedStrategy)
      const queryOk = !q || tradeLogs.columns.some(column => String(row[column] ?? '').toLowerCase().includes(q))
      return strategyOk && queryOk
    })
  }, [tradeLogs, query, selectedStrategy])

  const tradeLogSummary = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of tradeLogRows) {
      const event = String(row.Event || row['Log Type'] || 'MESSAGE').trim() || 'MESSAGE'
      counts.set(event, (counts.get(event) || 0) + 1)
    }
    return [
      ['Rows', tradeLogRows.length],
      ['Date', tradeLogs.meta?.date || payload.meta?.uploadDate || '--'],
      ['Strategy', selectedStrategy === 'all' ? 'All' : selectedStrategy],
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4),
    ]
  }, [payload.meta?.uploadDate, selectedStrategy, tradeLogRows, tradeLogs.meta?.date])

  const spotIvPoints = useMemo<SpotIvPoint[]>(() => {
    return spotIv.rows
      .map(row => {
        const timestamp = parseTimestamp(row.time_s || row.Timestamp || row.Time || row.Date)
        const spot = isNumeric(row.spot) ? asNumber(row.spot) : isNumeric(row.Spot) ? asNumber(row.Spot) : null
        const avgIv = isNumeric(row.avg_iv) ? asNumber(row.avg_iv) : isNumeric(row.IV) ? asNumber(row.IV) : null
        if (!timestamp || (spot === null && avgIv === null)) return null
        return {
          time: Math.floor(timestamp / 1000),
          rawTime: String(row.time_s || row.Timestamp || row.Time || row.Date || ''),
          spot,
          avgIv,
        }
      })
      .filter((point): point is SpotIvPoint => Boolean(point))
      .sort((a, b) => a.time - b.time)
  }, [spotIv.rows])

  useEffect(() => {
    let cancelled = false
    fetch('/api/journal/dates')
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.error ?? 'Unable to load MTM dates.')
        return data as { dates?: string[] }
      })
      .then(data => {
        if (cancelled) return
        setAvailableDates(data.dates || [])
      })
      .catch(() => {
        if (cancelled) return
        setAvailableDates([])
      })
    return () => { cancelled = true }
  }, [])

  async function refreshDates() {
    const response = await fetch('/api/journal/dates')
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data?.error ?? 'Unable to load MTM dates.')
    setAvailableDates(data.dates || [])
    return data.dates || []
  }

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    if (isAllDatesMode) params.set('all', '1')
    else if (selectedDate) params.set('date', selectedDate)

    setStatus(isAllDatesMode ? 'Loading all-date Cum P&L...' : selectedDate ? `Loading ${selectedDate}...` : 'Loading journal...')
    fetch(`/api/journal/mtm?${params.toString()}`)
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.error ?? 'Unable to load journal data.')
        return data as JournalPayload
      })
      .then(data => {
        if (cancelled) return
        setPayload(data)
        setSelectedStrategy('all')
        setQuery('')
        setStatus(data.meta?.allDates ? `Loaded Cum P&L across ${data.meta.dates?.length || 0} dates` : data.meta?.fileName ? `Loaded ${data.meta.fileName}` : 'Loaded journal data')
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Unable to load journal data.')
        setStatus('Journal data unavailable')
      })
    return () => { cancelled = true }
  }, [isAllDatesMode, selectedDate])

  useEffect(() => {
    if (activeTab !== 'tradeLogs') return
    let cancelled = false
    const params = new URLSearchParams()
    if (payload.meta?.uploadDate) params.set('date', payload.meta.uploadDate)
    if (selectedStrategy !== 'all') params.set('strategy', selectedStrategy)

    setStatus('Loading trade logs...')
    fetch(`/api/journal/logs?${params.toString()}`)
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.error ?? 'Unable to load trade logs.')
        return data as JournalPayload
      })
      .then(data => {
        if (cancelled) return
        setTradeLogs(data)
        setStatus(data.meta?.missing ? `No trade logs for ${data.meta.date}` : data.meta?.fileName ? `Loaded ${data.meta.fileName}` : 'Loaded trade logs')
        setError('')
      })
      .catch(() => {
        if (cancelled) return
        setTradeLogs({ columns: [], rows: [] })
        setError('')
        setStatus('Trade logs unavailable')
      })

    return () => { cancelled = true }
  }, [activeTab, payload.meta?.uploadDate, selectedStrategy])

  useEffect(() => {
    if (!isAllDatesMode && !payload.meta?.uploadDate) return
    let cancelled = false
    const params = new URLSearchParams()
    if (isAllDatesMode) params.set('all', '1')
    else if (payload.meta?.uploadDate) params.set('date', payload.meta.uploadDate)

    fetch(`/api/journal/spot-iv?${params.toString()}`)
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.error ?? 'Unable to load Spot/IV data.')
        return data as JournalPayload
      })
      .then(data => {
        if (cancelled) return
        setSpotIv(data)
      })
      .catch(() => {
        if (cancelled) return
        setSpotIv({ columns: [], rows: [] })
      })

    return () => { cancelled = true }
  }, [isAllDatesMode, payload.meta?.uploadDate])

  useEffect(() => {
    const host = chartHostRef.current
    if (!host) return

    const traces: Record<string, unknown>[] = chartTraces.map(trace => ({
      type: 'scatter',
      mode: 'lines',
      name: trace.strategy,
      x: trace.points.map(point => new Date(point.time * 1000)),
      y: trace.points.map(point => point.value),
      line: { color: trace.color, width: selectedStrategy === 'all' ? 1.8 : 2.5, shape: 'linear' },
      hovertemplate: [
        '<b>%{fullData.name}</b>',
        'Time %{x|%d-%b-%Y %H:%M:%S}',
        `${activeTab === 'cumPnl' ? 'Cum P&L' : 'MTM'} %{y:,.0f}`,
        '<extra></extra>',
      ].join('<br>'),
    }))

    if (spotIvPoints.some(point => point.spot !== null)) {
      traces.push({
        type: 'scatter',
        mode: 'lines',
        name: 'Spot Price',
        x: spotIvPoints.map(point => new Date(point.time * 1000)),
        y: spotIvPoints.map(point => point.spot),
        yaxis: 'y2',
        line: { color: '#6366f1', width: 1.8 },
        hovertemplate: '<b>Spot Price</b><br>%{x|%d-%b-%Y %H:%M:%S}<br>Spot %{y:,.2f}<extra></extra>',
      })
    }

    if (spotIvPoints.some(point => point.avgIv !== null)) {
      traces.push({
        type: 'scatter',
        mode: 'lines',
        name: 'Avg IV',
        x: spotIvPoints.map(point => new Date(point.time * 1000)),
        y: spotIvPoints.map(point => point.avgIv),
        yaxis: 'y3',
        line: { color: '#dc2626', width: 2.1 },
        hovertemplate: '<b>Avg IV</b><br>%{x|%d-%b-%Y %H:%M:%S}<br>IV %{y:,.2f}%<extra></extra>',
      })
    }

    Plotly.react(host, traces, {
      autosize: true,
      margin: { l: 54, r: 82, t: 22, b: 64 },
      paper_bgcolor: '#0d0d0d',
      plot_bgcolor: '#0d0d0d',
      font: { family: 'Roboto, "CircularXXWeb-Regular", Inter, Arial, sans-serif', size: 11, color: 'rgba(255,255,255,.58)' },
      xaxis: {
        type: 'date',
        showgrid: true,
        gridcolor: 'rgba(255,255,255,.035)',
        zeroline: false,
        linecolor: 'rgba(255,255,255,.12)',
        tickfont: { color: 'rgba(255,255,255,.52)' },
        automargin: true,
        rangeslider: { visible: false },
      },
      yaxis: {
        side: 'right',
        domain: [0, 1],
        showgrid: true,
        gridcolor: 'rgba(255,255,255,.035)',
        zeroline: true,
        zerolinecolor: 'rgba(255,255,255,.18)',
        linecolor: 'rgba(255,255,255,.12)',
        tickfont: { color: 'rgba(255,255,255,.52)' },
        tickformat: ',.0f',
        automargin: true,
      },
      yaxis2: {
        title: { text: 'Spot', font: { size: 10, color: '#818cf8' } },
        overlaying: 'y',
        side: 'left',
        showgrid: false,
        zeroline: false,
        tickfont: { size: 10, color: '#818cf8' },
        tickformat: ',.0f',
        automargin: true,
      },
      yaxis3: {
        title: { text: 'IV', font: { size: 10, color: '#f87171' } },
        overlaying: 'y',
        side: 'right',
        position: 0.97,
        showgrid: false,
        zeroline: false,
        tickfont: { size: 10, color: '#f87171' },
        tickformat: ',.1f',
        automargin: true,
      },
      showlegend: selectedStrategy === 'all' || spotIvPoints.length > 0,
      legend: {
        orientation: 'h',
        x: 0,
        y: 1.08,
        xanchor: 'left',
        yanchor: 'bottom',
        font: { size: 10, color: 'rgba(255,255,255,.62)' },
        bgcolor: 'rgba(13,13,13,.72)',
        bordercolor: 'rgba(255,255,255,.08)',
        borderwidth: 1,
      },
      hovermode: 'x unified',
      hoverlabel: {
        bgcolor: '#171717',
        bordercolor: 'rgba(255,255,255,.14)',
        font: { family: 'Roboto, "CircularXXWeb-Regular", Inter, Arial, sans-serif', size: 12, color: '#f5f5f5' },
      },
    }, {
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      responsive: true,
    })

    return () => {
      Plotly.purge(host)
    }
  }, [activeTab, chartTraces, selectedStrategy, spotIvPoints])

  async function uploadMtmCsv(file: File, appendDuplicate = false) {
    const csv = (await file.text()).replace(/^\uFEFF/, '')
    const response = await fetch('/api/journal/mtm/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv, fileName: file.name, appendDuplicate }),
    })
    const data = await response.json().catch(() => ({}))

    if (response.status === 409 && data?.duplicate) {
      const shouldAppend = window.confirm(data.message || `Data for ${data.uploadDate} already exists. Append newer rows?`)
      if (!shouldAppend) return null
      return uploadMtmCsv(file, true)
    }

    if (!response.ok) throw new Error(data?.error ?? 'MTM upload failed.')
    return data as JournalPayload
  }

  async function handleCsvUpload(file: File) {
    try {
      setStatus(`Uploading ${file.name}...`)
      const data = await uploadMtmCsv(file)
      if (!data) {
        setStatus('MTM upload cancelled')
        return
      }
      setPayload(data)
      setSelectedStrategy('all')
      setQuery('')
      setStatus(data.meta?.fileName ? `Saved ${data.meta.fileName}` : `Saved ${file.name}`)
      setError('')
      await refreshDates()
      setSelectedDate(data.meta?.uploadDate || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MTM upload failed.')
      setStatus('MTM upload failed')
    }
  }

  async function handleLogUpload(file: File) {
    try {
      setStatus(`Uploading logs ${file.name}...`)
      const csv = (await file.text()).replace(/^\uFEFF/, '')
      const response = await fetch('/api/journal/logs/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv, fileName: file.name }),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 409 && data?.duplicate) {
        const shouldAppend = window.confirm(data.message || `Logs for ${data.uploadDate} already exist. Append only new rows?`)
        if (!shouldAppend) {
          setStatus('Log upload cancelled')
          return
        }
        const appendResponse = await fetch('/api/journal/logs/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ csv, fileName: file.name, appendDuplicate: true }),
        })
        const appendData = await appendResponse.json().catch(() => ({}))
        if (!appendResponse.ok) throw new Error(appendData?.error ?? 'Log upload failed.')
        setTradeLogs(appendData)
        setSelectedDate(appendData.meta?.date || selectedDate)
        setStatus(appendData.meta?.fileName ? `Saved ${appendData.meta.fileName}` : `Saved logs ${file.name}`)
      } else {
        if (!response.ok) throw new Error(data?.error ?? 'Log upload failed.')
        setTradeLogs(data)
        setSelectedDate(data.meta?.date || selectedDate)
        setStatus(data.meta?.fileName ? `Saved ${data.meta.fileName}` : `Saved logs ${file.name}`)
      }
      setError('')
      setActiveTab('tradeLogs')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Log upload failed.')
      setStatus('Log upload failed')
    }
  }

  async function handleSpotIvUpload(file: File) {
    try {
      setStatus(`Uploading Spot/IV ${file.name}...`)
      const base64 = await fileToBase64(file)
      const response = await fetch('/api/journal/spot-iv/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base64, fileName: file.name }),
      })
      const data = await response.json().catch(() => ({}))

      let result = data
      if (response.status === 409 && data?.duplicate) {
        const shouldAppend = window.confirm(data.message || 'Spot/IV data already exists. Append only new rows?')
        if (!shouldAppend) {
          setStatus('Spot/IV upload cancelled')
          return
        }
        const appendResponse = await fetch('/api/journal/spot-iv/upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ base64, fileName: file.name, appendDuplicate: true }),
        })
        result = await appendResponse.json().catch(() => ({}))
        if (!appendResponse.ok) throw new Error(result?.error ?? 'Spot/IV upload failed.')
      } else if (!response.ok) {
        throw new Error(data?.error ?? 'Spot/IV upload failed.')
      }

      const savedDates = (result.saved || []).map((item: { date: string }) => item.date).filter(Boolean)
      const targetDate = savedDates.includes(payload.meta?.uploadDate || '') ? payload.meta?.uploadDate : savedDates[0]
      if (targetDate) {
        const spotResponse = await fetch(`/api/journal/spot-iv?date=${encodeURIComponent(targetDate)}`)
        const spotData = await spotResponse.json().catch(() => ({}))
        if (spotResponse.ok) setSpotIv(spotData)
        if (!selectedDate && availableDates.includes(targetDate)) setSelectedDate(targetDate)
      }
      setStatus(savedDates.length ? `Saved Spot/IV for ${savedDates.join(', ')}` : `Saved Spot/IV ${file.name}`)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Spot/IV upload failed.')
      setStatus('Spot/IV upload failed')
    }
  }

  const chartTitle = activeTab === 'cumPnl'
    ? 'Cumulative P&L'
    : selectedStrategy === 'all' ? 'All strategies' : selectedStrategy

  const tableRows = visibleRows
  const tableColumns = columns
  const tableTitle = 'Journal Rows'
  const loadedDate = payload.meta?.loadedDate || payload.meta?.uploadDate || selectedDate
  const sourceLabel = payload.meta?.fileName || 'D:\\mtm-analyzer\\data\\mtm.csv'
  const activeBook = selectedStrategy === 'all' ? 'All strategies' : selectedStrategy
  const latestValue = selectedSummary.latest?.value ?? metrics.total
  const givebackValue = selectedSummary.drawdown?.dip ?? metrics.drawdown
  const sourceUpdated = payload.meta?.updatedAt ? new Date(payload.meta.updatedAt).toLocaleString('en-IN') : 'Live file watch'

  const hasTable = activeTab === 'rows'

  return (
    <main className={`journal-main native-journal ${hasTable ? 'journal-has-table' : ''}`}>
      <section className="journal-head">
        <div>
          <span className="subview-eyebrow">P&L Journal / ALPHAHEDGEOSS</span>
          <h1>Daily P&L Command Center</h1>
          <p>MTM curve, one-analysis risk points, cumulative P&L, trade logs, and raw rows in one workspace.</p>
        </div>
        <div className="journal-actions">
          <label className="ghost-inline journal-upload">
            Upload MTM
            <input type="file" accept=".csv,text/csv" onChange={event => {
              const file = event.target.files?.[0]
              if (file) void handleCsvUpload(file)
              event.currentTarget.value = ''
            }} />
          </label>
          <label className="ghost-inline journal-upload">
            Add Logs
            <input type="file" accept=".csv,text/csv" onChange={event => {
              const file = event.target.files?.[0]
              if (file) void handleLogUpload(file)
              event.currentTarget.value = ''
            }} />
          </label>
          <label className="ghost-inline journal-upload">
            Add Spot/IV
            <input type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" onChange={event => {
              const file = event.target.files?.[0]
              if (file) void handleSpotIvUpload(file)
              event.currentTarget.value = ''
            }} />
          </label>
          <button type="button" className="ghost-inline" onClick={onBack}>Back</button>
        </div>
      </section>

      <section className="journal-command-deck" aria-label="Journal command summary">
        <article className="journal-command-card journal-command-primary">
          <span>Source & Sync</span>
          <strong>{sourceLabel}</strong>
          <small>{sourceUpdated}</small>
        </article>
        <article className="journal-command-card">
          <span>Active Book</span>
          <strong>{activeBook}</strong>
          <p>{metrics.visible} visible rows across {analysisRows.length} scanned strategies.</p>
          <small>{chartData.length} chart points ready</small>
        </article>
        <article className="journal-command-card">
          <span>Risk Snapshot</span>
          <strong className={(latestValue ?? 0) < 0 ? 'neg-text' : 'pos-text'}>{formatMoney(latestValue)}</strong>
          <p>Worst giveback: <b className="neg-text">{formatMoney(givebackValue)}</b></p>
          <small>{selectedSummary.negative ? `First negative at ${selectedSummary.negative.rawTime}` : 'No negative point in current filter'}</small>
        </article>
        <article className="journal-command-card">
          <span>Attached Logs</span>
          <strong>{tradeLogs.rows.length ? `${tradeLogs.rows.length} rows` : tradeLogs.meta?.missing ? 'No logs' : 'Not loaded'}</strong>
          <p>Drop strategy execution logs here and review them beside MTM.</p>
          <small>{tradeLogs.meta?.missing ? `No file for ${tradeLogs.meta.date}` : tradeLogs.meta?.fileName || 'CSV upload optional'}</small>
        </article>
        <article className="journal-command-card">
          <span>Spot / IV</span>
          <strong>{spotIv.rows.length ? `${spotIv.rows.length} rows` : 'Not loaded'}</strong>
          <p>Spot Price and Avg IV overlay on the MTM chart.</p>
          <small>{spotIv.meta?.allDates ? `${spotIv.meta.dates?.length || 0} dates matched` : spotIv.meta?.fileName || 'Reads matching analyzer date'}</small>
        </article>
      </section>

      <nav className="journal-tabs" aria-label="Journal views">
        {([
          ['chart', 'Chart'],
          ['analysis', 'One Analysis'],
          ['cumPnl', 'Cum P&L'],
          ['tradeLogs', 'Trade Logs'],
          ['rows', 'Rows'],
        ] as Array<[ActiveTab, string]>).map(([key, label]) => (
          <button key={key} type="button" className={activeTab === key ? 'active' : ''} onClick={() => setActiveTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      {error && <div className="err-banner journal-banner">{error}</div>}

      <section className="journal-metrics">
        <div><span>Total MTM</span><strong className={(metrics.total ?? 0) < 0 ? 'neg-text' : 'pos-text'}>{formatMoney(metrics.total)}</strong></div>
        <div><span>Rows</span><strong>{metrics.rows}</strong></div>
        <div><span>Strategies</span><strong>{metrics.strategies}</strong></div>
        <div><span>High</span><strong className="pos-text">{formatMoney(metrics.high)}</strong></div>
        <div><span>Low</span><strong className="neg-text">{formatMoney(metrics.low)}</strong></div>
        <div><span>Worst Giveback</span><strong className="neg-text">{formatMoney(metrics.drawdown)}</strong></div>
      </section>

      <section className="journal-grid">
        <div className="journal-chart-panel">
          <div className="journal-panel-top">
            <div>
              <span className="summary-label">{activeTab === 'cumPnl' ? 'Across Selected Rows' : 'MTM Curve'}</span>
              <h2>{chartTitle}</h2>
            </div>
            <span className="pill-v2 pill-accent">{status}</span>
          </div>
          <div className={`journal-chart ${activeTab === 'chart' || activeTab === 'cumPnl' ? '' : 'journal-chart-hidden'}`} ref={chartHostRef} />
          {activeTab === 'analysis' && (
            <div className="journal-analysis">
              {analysisRows.map(row => (
                <article key={row.strategy} className="journal-analysis-card">
                  <header>
                    <div><strong>{row.strategy}</strong><span>{row.points} MTM points</span></div>
                    <b className={(row.latest?.value ?? 0) < 0 ? 'neg-text' : 'pos-text'}>{formatMoney(row.latest?.value ?? null)}</b>
                  </header>
                  <div className="journal-analysis-grid">
                    <span><small>Entry</small><b>{formatMoney(row.entry?.value ?? null)}</b></span>
                    <span><small>Peak</small><b className="pos-text">{formatMoney(row.high?.value ?? null)}</b></span>
                    <span><small>Low</small><b className="neg-text">{formatMoney(row.low?.value ?? null)}</b></span>
                    <span><small>First Negative</small><b className="neg-text">{formatMoney(row.negative?.value ?? null)}</b></span>
                    <span><small>Worst Giveback</small><b className="neg-text">{formatMoney(row.drawdown?.dip ?? null)}</b></span>
                    <span><small>Giveback Time</small><b>{row.drawdown?.low.rawTime || '--'}</b></span>
                  </div>
                </article>
              ))}
            </div>
          )}
          {activeTab === 'tradeLogs' && (
            <div className="journal-log-console">
              <div className="journal-log-summary">
                {tradeLogSummary.map(([label, value]) => (
                  <div key={label} className="journal-log-card">
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <div className="journal-log-table-wrap">
                <table className="journal-table journal-log-table">
                  <thead>
                    <tr>{logColumns(tradeLogs.columns).map(column => <th key={column}>{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    {tradeLogRows.slice(0, 1000).map((row, index) => {
                      const cls = eventClass(row.Event || row['Log Type'])
                      return (
                        <tr key={index} className={`log-row ${cls}`}>
                          {logColumns(tradeLogs.columns).map(column => {
                            if (column === 'Event') {
                              const event = row.Event || row['Log Type'] || 'MESSAGE'
                              return <td key={column} className="event-cell"><span className={`event-pill ${eventClass(event)}`}>{event}</span></td>
                            }
                            if (column === 'Details') {
                              return (
                                <td key={column} className="details-cell">
                                  <div className="log-details">
                                    {row.Symbol && <span className="detail-chip symbol-chip">{row.Symbol}</span>}
                                    {row.Txn && <span className={`detail-chip txn-${String(row.Txn).toLowerCase()}`}>{row.Txn}</span>}
                                    {row.Qty && <span className="detail-chip"><b>Qty</b>{row.Qty}</span>}
                                    {row.LegID && <span className="detail-chip"><b>Leg</b>{row.LegID}</span>}
                                    {row.OrderID && <span className="detail-chip"><b>Order</b>{row.OrderID}</span>}
                                    {row.IsExit && <span className="detail-chip"><b>Exit</b>{row.IsExit}</span>}
                                  </div>
                                </td>
                              )
                            }
                            return <td key={column} className={column === 'Message' ? 'message-cell' : ''}>{row[column] ?? ''}</td>
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {tradeLogRows.length === 0 && <div className="table-empty">No trade logs match the selected strategy and search.</div>}
              </div>
            </div>
          )}
          {activeTab === 'rows' && (
            <div className="journal-mini-empty">
              <strong>{tableTitle}</strong>
              <span>{tableRows.length} rows visible below. Use search and strategy filters on the left.</span>
            </div>
          )}
        </div>

        <aside className="journal-side">
          <label className="journal-control">
            <span>MTM Date</span>
            <select value={selectedDate} onChange={event => setSelectedDate(event.target.value)} disabled={isAllDatesMode}>
              <option value="">Latest CSV</option>
              {availableDates.map(date => <option key={date} value={date}>{date}</option>)}
            </select>
          </label>
          <label className="journal-control">
            <span>Strategy</span>
            <select value={selectedStrategy} onChange={event => setSelectedStrategy(event.target.value)}>
              <option value="all">All strategies</option>
              {strategies.map(strategy => <option key={strategy} value={strategy}>{strategy}</option>)}
            </select>
          </label>
          <label className="journal-control">
            <span>Search rows</span>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search symbol, time, MTM..." />
          </label>
          <div className="journal-side-stats">
            <div><span>Entry</span><strong>{formatMoney(selectedSummary.entry?.value ?? null)}</strong></div>
            <div><span>Latest</span><strong className={(selectedSummary.latest?.value ?? 0) < 0 ? 'neg-text' : 'pos-text'}>{formatMoney(selectedSummary.latest?.value ?? null)}</strong></div>
            <div><span>Peak</span><strong className="pos-text">{formatMoney(selectedSummary.high?.value ?? null)}</strong></div>
            <div><span>Low</span><strong className="neg-text">{formatMoney(selectedSummary.low?.value ?? null)}</strong></div>
          </div>
          <div className="journal-note">
            <span className="live-dot" />
            Reads <strong>{payload.meta?.allDates ? `all saved MTM dates (${payload.meta.dates?.length || 0})` : loadedDate ? `mtm-${loadedDate}.parquet` : 'D:\\mtm-analyzer\\data\\mtm.csv'}</strong> when running the Alphahedge dev server.
          </div>
        </aside>
      </section>

      {hasTable && (
        <section className="journal-table-shell">
          <div className="journal-panel-top">
            <div>
              <span className="summary-label">Raw Data</span>
              <h2>{tableTitle}</h2>
            </div>
            <span className="section-meta">{tableRows.length} visible</span>
          </div>
          <div className="journal-table-wrap">
            <table className="journal-table">
              <thead>
                <tr>{tableColumns.map(column => <th key={column}>{column}</th>)}</tr>
              </thead>
              <tbody>
                {tableRows.slice(0, 500).map((row, index) => (
                  <tr key={index}>
                    {tableColumns.map(column => {
                      const value = row[column] ?? ''
                      const cls = isNumeric(value) && asNumber(value) < 0 ? 'negative' : isNumeric(value) && /mtm|p&l|pnl|profit|loss|net/i.test(column) ? 'positive' : ''
                      return <td key={column} className={cls}>{formatCell(value)}</td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {tableRows.length === 0 && <div className="table-empty">No rows match the current view and filter.</div>}
          </div>
        </section>
      )}
    </main>
  )
}
