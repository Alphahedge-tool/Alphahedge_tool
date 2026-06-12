import { useEffect, useMemo, useRef, useState } from 'react'

export type InhouseSeries = {
  label: string
  values: Array<number | null>
  stroke: string
  axisId?: 'left' | 'right' | 'iv' | 'vol'
  width?: number
  dashed?: boolean
}

type InhouseStrategyChartProps = {
  timestamps: number[]
  series: InhouseSeries[]
  title: string
  value: string
  onLeftEdge?: () => void
  prependCount?: number
}

const axisWidth = 82
const sideGutter = 22
const pad = { top: 22, bottom: 38 }

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function valueFormat(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '--'
  if (Math.abs(value) >= 1000) return value.toFixed(0)
  if (Math.abs(value) >= 100) return value.toFixed(1)
  return value.toFixed(2)
}

function timeFormat(seconds: number) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000))
}

function cursorTimeFormat(seconds: number) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000))
}

function visibleRange(length: number, startRatio: number, endRatio: number) {
  const last = Math.max(0, length - 1)
  const start = Math.floor(clamp(startRatio, 0, 0.98) * last)
  const end = Math.ceil(clamp(endRatio, 0.02, 1) * Math.max(1, last))
  return [Math.max(0, start), Math.max(start + 1, Math.min(last, end))]
}

function minMax(series: InhouseSeries[], start: number, end: number) {
  let min = Infinity
  let max = -Infinity
  for (const item of series) {
    for (let index = start; index <= end; index += 1) {
      const value = item.values[index]
      if (!Number.isFinite(value)) continue
      min = Math.min(min, value as number)
      max = Math.max(max, value as number)
    }
  }
  if (!Number.isFinite(min)) return [0, 1]
  if (min === max) return [min - 1, max + 1]
  const padding = (max - min) * 0.08
  return [min - padding, max + padding]
}

export default function InhouseStrategyChart({ timestamps, series, title, value, onLeftEdge, prependCount }: InhouseStrategyChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pointerRef = useRef<{ x: number; y: number; range: { start: number; end: number }; yPan: number } | null>(null)
  const [range, setRange] = useState({ start: 0, end: 1 })
  const [yPan, setYPan] = useState(0)
  const [cursor, setCursor] = useState<{ x: number; y: number; index: number } | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [sizeTick, setSizeTick] = useState(0)

  const prevTotalRef = useRef(timestamps.length)
  useEffect(() => {
    if (!prependCount || prependCount <= 0 || timestamps.length === 0) return
    const newTotal = timestamps.length
    const shift = prependCount / newTotal
    setRange(current => {
      const start = clamp(current.start + shift, 0, 1)
      const end = clamp(current.end + shift, start + 0.01, 1)
      return { start, end }
    })
    leftEdgeFiredRef.current = false
    prevTotalRef.current = newTotal
  }, [prependCount, timestamps.length])

  const rows = useMemo(() => {
    const index = cursor?.index ?? timestamps.length - 1
    return series.map(item => ({
      ...item,
      value: valueFormat(item.values[index]),
      visible: !hidden.has(item.label),
    }))
  }, [cursor?.index, hidden, series, timestamps.length])

  function toggle(label: string) {
    setHidden(current => {
      const next = new Set(current)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  function fit() {
    setRange({ start: 0, end: 1 })
    setYPan(0)
  }

  function zoom(factor: number) {
    setRange(current => {
      const span = current.end - current.start
      const nextSpan = clamp(span * factor, 0.025, 1)
      const center = current.start + span / 2
      const start = clamp(center - nextSpan / 2, 0, 1 - nextSpan)
      return { start, end: start + nextSpan }
    })
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(() => setSizeTick(tick => tick + 1))
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host || timestamps.length === 0 || series.length === 0) return

    const dpr = window.devicePixelRatio || 1
    const rect = host.getBoundingClientRect()
    const width = Math.max(420, Math.floor(rect.width))
    const height = Math.max(320, Math.floor(rect.height))
    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)

    const visibleSeries = series.filter(item => !hidden.has(item.label))
    const [start, end] = visibleRange(timestamps.length, range.start, range.end)
    const leftSeries = visibleSeries.filter(item => item.axisId === 'left')
    const ivSeries = visibleSeries.filter(item => item.axisId === 'iv')
    const volSeries = visibleSeries.filter(item => item.axisId === 'vol')
    const rightSeries = visibleSeries.filter(item => item.axisId !== 'left' && item.axisId !== 'iv' && item.axisId !== 'vol')
    const axes = [
      ...(leftSeries.length ? [{ id: 'left', side: 'left', series: leftSeries, color: leftSeries[0].stroke }] : []),
      ...(volSeries.length ? [{ id: 'vol', side: 'left', series: volSeries, color: volSeries[0].stroke }] : []),
      ...(rightSeries.length ? [{ id: 'right', side: 'right', series: rightSeries, color: rightSeries[0].stroke }] : []),
      ...(ivSeries.length ? [{ id: 'iv', side: 'right', series: ivSeries, color: ivSeries[0].stroke }] : []),
    ].map(axis => ({ ...axis, range: minMax(axis.series, start, end) }))

    const leftCount = axes.filter(axis => axis.side === 'left').length
    const rightCount = Math.max(1, axes.filter(axis => axis.side === 'right').length)
    const plot = {
      left: sideGutter + leftCount * axisWidth,
      top: pad.top,
      right: width - sideGutter - rightCount * axisWidth,
      bottom: height - pad.bottom,
    }
    const plotWidth = Math.max(80, plot.right - plot.left)
    const plotHeight = Math.max(80, plot.bottom - plot.top)
    const visibleSpan = Math.max(1, end - start)
    const rightOffsetBars = Math.max(4, Math.round(visibleSpan * 0.045))
    const xScaleSpan = visibleSpan + rightOffsetBars
    const xFor = (index: number) => plot.left + ((index - start) / xScaleSpan) * plotWidth
    const axisFor = (item: InhouseSeries) => axes.find(axis => axis.id === (item.axisId ?? 'right')) ?? axes[0]
    const yFor = (item: InhouseSeries, yValue: number) => {
      const axis = axisFor(item)
      const [min, max] = axis?.range ?? [0, 1]
      const span = Math.max(1e-9, max - min)
      const shiftedMin = min + yPan * span
      return plot.bottom - ((yValue - shiftedMin) / span) * plotHeight
    }

    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    for (let step = 0; step <= 4; step += 1) {
      const y = plot.top + (plotHeight * step) / 4
      ctx.beginPath()
      ctx.moveTo(plot.left, y)
      ctx.lineTo(plot.right, y)
      ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.052)'
    const verticalTicks = Math.min(9, end - start + 1)
    for (let step = 0; step < verticalTicks; step += 1) {
      const index = Math.round(start + ((end - start) * step) / Math.max(1, verticalTicks - 1))
      const x = xFor(index)
      ctx.beginPath()
      ctx.moveTo(x, plot.top)
      ctx.lineTo(x, plot.bottom)
      ctx.stroke()
    }

    const primary = visibleSeries[0]
    if (primary) {
      let maxMove = 0
      const moves: number[] = []
      for (let index = start + 1; index <= end; index += 1) {
        const move = Math.abs(Number(primary.values[index] ?? 0) - Number(primary.values[index - 1] ?? 0))
        moves[index] = move
        maxMove = Math.max(maxMove, move)
      }
      for (let index = start + 1; index <= end; index += 1) {
        const intensity = maxMove ? clamp(moves[index] / maxMove, 0, 1) : 0
        if (intensity < 0.22) continue
        const x1 = xFor(index - 1)
        const x2 = xFor(index)
        ctx.fillStyle = `rgba(5, 184, 120, ${0.025 + intensity * 0.095})`
        ctx.fillRect(x1, plot.top, Math.max(1, x2 - x1), plotHeight)
      }
    }

    ctx.save()
    ctx.beginPath()
    ctx.rect(plot.left, plot.top, plot.right - plot.left, plotHeight)
    ctx.clip()
    for (const item of visibleSeries) {
      ctx.strokeStyle = item.stroke
      ctx.lineWidth = item.width ?? 2
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.setLineDash(item.dashed ? [7, 5] : [])
      ctx.beginPath()
      let started = false
      for (let index = start; index <= end; index += 1) {
        const yValue = item.values[index]
        if (!Number.isFinite(yValue)) {
          started = false
          continue
        }
        const x = xFor(index)
        const y = yFor(item, yValue as number)
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else {
          ctx.lineTo(x, y)
        }
      }
      ctx.stroke()
      ctx.setLineDash([])
      const latestIndex = end
      const latestValue = item.values[latestIndex]
      if (Number.isFinite(latestValue)) {
        ctx.fillStyle = item.stroke
        ctx.beginPath()
        ctx.arc(xFor(latestIndex), yFor(item, latestValue as number), 4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()

    axes.forEach((axis, axisIndex) => {
      const column = axes.filter(item => item.side === axis.side).findIndex(item => item.id === axis.id)
      const x = axis.side === 'left'
        ? plot.left - 14 - column * axisWidth
        : plot.right + 18 + column * axisWidth
      const [min, max] = axis.range
      ctx.strokeStyle = axis.color
      ctx.globalAlpha = 0.58
      ctx.beginPath()
      ctx.moveTo(x, plot.top)
      ctx.lineTo(x, plot.bottom)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = axis.color
      ctx.font = '11px Inter, Arial, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.textAlign = axis.side === 'left' ? 'right' : 'left'
      for (let step = 0; step <= 4; step += 1) {
        const span = Math.max(1e-9, max - min)
        const shiftedMin = min + yPan * span
        const axisValue = shiftedMin + (span * step) / 4
        const y = plot.bottom - ((axisValue - shiftedMin) / span) * plotHeight
        ctx.fillText(valueFormat(axisValue), x + (axis.side === 'left' ? -5 : 5), y)
      }
      ctx.save()
      ctx.translate(x + (axis.side === 'left' ? -50 : 54), plot.top + 6 + axisIndex * 4)
      ctx.rotate(-Math.PI / 2)
      ctx.font = '700 10px Inter, Arial, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(axis.series.map(item => item.label).join(' / ').slice(0, 30), 0, 0)
      ctx.restore()
    })

    ctx.strokeStyle = 'rgba(255,255,255,0.055)'
    ctx.fillStyle = 'rgba(218,218,218,0.58)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.font = '11px Inter, Arial, sans-serif'
    const ticks = Math.min(7, end - start + 1)
    for (let step = 0; step < ticks; step += 1) {
      const index = Math.round(start + ((end - start) * step) / Math.max(1, ticks - 1))
      const x = xFor(index)
      ctx.beginPath()
      ctx.moveTo(x, plot.top)
      ctx.lineTo(x, plot.bottom)
      ctx.stroke()
      ctx.fillText(timeFormat(timestamps[index]), x, plot.bottom + 12)
    }

    if (cursor && cursor.index >= start && cursor.index <= end) {
      const x = clamp(cursor.x, plot.left, plot.right)
      ctx.strokeStyle = 'rgba(5,184,120,0.55)'
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(x, plot.top)
      ctx.lineTo(x, plot.bottom)
      ctx.stroke()
      ctx.setLineDash([])
      const visibleRows = visibleSeries.map(item => `${item.label}: ${valueFormat(item.values[cursor.index])}`)
      const tooltipWidth = Math.max(190, ...visibleRows.map(row => row.length * 6.4))
      const tooltipHeight = 28 + visibleRows.length * 17
      const tipLeft = clamp(x + 10, plot.left + 4, plot.right - tooltipWidth - 4)
      const tipTop = clamp(cursor.y - tooltipHeight - 10, plot.top + 4, plot.bottom - tooltipHeight - 4)
      ctx.fillStyle = 'rgba(18,18,18,0.94)'
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'
      ctx.fillRect(tipLeft, tipTop, tooltipWidth, tooltipHeight)
      ctx.strokeRect(tipLeft, tipTop, tooltipWidth, tooltipHeight)
      ctx.fillStyle = '#ffffff'
      ctx.font = '700 11px Inter, Arial, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(cursorTimeFormat(timestamps[cursor.index]), tipLeft + 9, tipTop + 8)
      ctx.font = '11px Inter, Arial, sans-serif'
      visibleRows.forEach((row, rowIndex) => ctx.fillText(row, tipLeft + 9, tipTop + 27 + rowIndex * 17))
    }

    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(plot.left, plot.bottom + 26, plotWidth, 3)
    ctx.fillStyle = '#05b878'
    ctx.fillRect(plot.left + plotWidth * range.start, plot.bottom + 26, plotWidth * (range.end - range.start), 3)
  }, [cursor, hidden, range, series, sizeTick, timestamps, yPan])

  function plotForRect(rect: DOMRect) {
    const leftCount = Number(rows.some(row => row.axisId === 'left' && row.visible)) +
      Number(rows.some(row => row.axisId === 'vol' && row.visible))
    const rightCount = Math.max(1,
      Number(rows.some(row => row.visible && row.axisId !== 'left' && row.axisId !== 'iv' && row.axisId !== 'vol')) +
      Number(rows.some(row => row.axisId === 'iv' && row.visible)),
    )
    return {
      left: sideGutter + leftCount * axisWidth,
      right: rect.width - sideGutter - rightCount * axisWidth,
    }
  }

  function updateCursor(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas || !timestamps.length) return
    const rect = canvas.getBoundingClientRect()
    const plot = plotForRect(rect)
    const [start, end] = visibleRange(timestamps.length, range.start, range.end)
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const ratio = clamp((x - plot.left) / Math.max(1, plot.right - plot.left), 0, 1)
    const visibleSpan = Math.max(1, end - start)
    const rightOffsetBars = Math.max(4, Math.round(visibleSpan * 0.045))
    const index = clamp(Math.round(start + ratio * (visibleSpan + rightOffsetBars)), start, end)
    setCursor({ x: clamp(x, plot.left, plot.right), y, index })
  }

  function onWheel(event: React.WheelEvent<HTMLCanvasElement>) {
    event.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const plot = plotForRect(rect)
    const anchor = clamp((event.clientX - rect.left - plot.left) / Math.max(1, plot.right - plot.left), 0, 1)
    setRange(current => {
      const span = current.end - current.start
      const isScrollLeft = event.deltaX < -8 || (Math.abs(event.deltaX) > Math.abs(event.deltaY) && event.deltaX < 0)
      if (isScrollLeft) {
        const panDelta = span * 0.18
        const start = clamp(current.start - panDelta, 0, 1 - span)
        if (start === 0 && current.start === 0) {
          if (!leftEdgeFiredRef.current) {
            leftEdgeFiredRef.current = true
            onLeftEdge?.()
          }
        } else {
          leftEdgeFiredRef.current = false
        }
        return { start, end: start + span }
      }
      const nextSpan = clamp(span * (event.deltaY > 0 ? 1.22 : 0.78), 0.025, 1)
      const center = current.start + span * anchor
      const start = clamp(center - nextSpan * anchor, 0, 1 - nextSpan)
      return { start, end: start + nextSpan }
    })
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    pointerRef.current = { x: event.clientX, y: event.clientY, range, yPan }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const leftEdgeFiredRef = useRef(false)

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    updateCursor(event)
    const pointer = pointerRef.current
    if (!pointer) return
    const rect = event.currentTarget.getBoundingClientRect()
    const span = pointer.range.end - pointer.range.start
    const delta = ((event.clientX - pointer.x) / Math.max(1, rect.width)) * span * 1.35
    const start = clamp(pointer.range.start - delta, 0, 1 - span)
    setRange({ start, end: start + span })
    const yDelta = (event.clientY - pointer.y) / Math.max(1, rect.height)
    setYPan(clamp(pointer.yPan + yDelta, -0.8, 0.8))
    if (start === 0 && !leftEdgeFiredRef.current) {
      leftEdgeFiredRef.current = true
      onLeftEdge?.()
    }
    if (start > 0) leftEdgeFiredRef.current = false
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    pointerRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div className="strategy-inhouse-chart">
      <div className="strategy-inhouse-toolbar">
        <div className="strategy-inhouse-title">
          <span>{title}</span>
          <strong>{value}</strong>
        </div>
        <div className="strategy-inhouse-actions">
          <button type="button" onClick={() => zoom(0.7)} title="Zoom in">+</button>
          <button type="button" onClick={() => zoom(1.35)} title="Zoom out">-</button>
          <button type="button" onClick={() => setYPan(value => clamp(value - 0.08, -0.8, 0.8))} title="Move chart up">Up</button>
          <button type="button" onClick={() => setYPan(value => clamp(value + 0.08, -0.8, 0.8))} title="Move chart down">Down</button>
          <button type="button" onClick={fit} title="Fit all data">Fit</button>
        </div>
      </div>
      <div className="strategy-inhouse-legend">
        {rows.map(row => (
          <button
            key={row.label}
            type="button"
            className={row.visible ? '' : 'off'}
            onClick={() => toggle(row.label)}
            title={`${row.label} axis: ${row.axisId ?? 'right'}`}
          >
            <i style={{ backgroundColor: row.stroke }} />
            <span>{row.label}</span>
            <small>{row.axisId ?? 'right'}</small>
            <strong>{row.value}</strong>
          </button>
        ))}
      </div>
      <div ref={hostRef} className="strategy-inhouse-host">
        <canvas
          ref={canvasRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onMouseLeave={() => {
            pointerRef.current = null
            setCursor(null)
          }}
        />
      </div>
    </div>
  )
}
