import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MTM_ROOT = 'D:\\mtm-analyzer'
const PARQUET_DIR = 'D:\\mtm-analyzer\\data\\parquet'
const MTM_CSV_FILE = 'D:\\mtm-analyzer\\data\\mtm.csv'
const MTM_META_FILE = 'D:\\mtm-analyzer\\data\\meta.json'
const LOGS_DIR = 'D:\\mtm-analyzer\\data\\logs'
const SPOT_IV_DIR = 'D:\\mtm-analyzer\\data\\spot-iv'
const analyzerRequire = createRequire(path.join(MTM_ROOT, 'package.json'))

type SpotIvJson = {
  data?: {
    ce?: Record<string, unknown[]>
    pe?: Record<string, unknown[]>
  }
}

function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      row.push(cell.trim())
      cell = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1
      row.push(cell.trim())
      if (row.some(Boolean)) rows.push(row)
      row = []
      cell = ''
      continue
    }

    cell += char
  }

  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)

  const columns = rows[0]?.map((name, index) => name || `Column ${index + 1}`) ?? []
  return {
    columns,
    rows: rows.slice(1).map(values => {
      const record: Record<string, string> = {}
      columns.forEach((column, index) => {
        record[column] = values[index] ?? ''
      })
      return record
    }),
  }
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function normalizeDateKey(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const monthNames: Record<string, string> = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07', july: '07',
    aug: '08', august: '08', sep: '09', sept: '09', september: '09', oct: '10',
    october: '10', nov: '11', november: '11', dec: '12', december: '12',
  }

  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`

  const indian = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)
  if (indian) return `${indian[3]}-${indian[2].padStart(2, '0')}-${indian[1].padStart(2, '0')}`

  const shortIndian = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})(?:\s|$)/)
  if (shortIndian) return `20${shortIndian[3]}-${shortIndian[2].padStart(2, '0')}-${shortIndian[1].padStart(2, '0')}`

  const namedMonth = raw.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})(?:\s|$)/)
  if (namedMonth) {
    const month = monthNames[namedMonth[2].toLowerCase()]
    if (month) {
      const year = namedMonth[3].length === 2 ? `20${namedMonth[3]}` : namedMonth[3]
      return `${year}-${month}-${namedMonth[1].padStart(2, '0')}`
    }
  }

  return ''
}

function parseTimestampMs(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const namedMonths: Record<string, number> = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
    september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
  }

  const named = raw.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (named) {
    const [, day, monthName, rawYear, hour = '0', minute = '0', second = '0'] = named
    const month = namedMonths[monthName.toLowerCase()]
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

  const iso = Date.parse(raw)
  return Number.isNaN(iso) ? null : iso
}

function findTimeColumn(columns: string[]) {
  return columns.find(column => /^(time|timestamp|datetime|date\s*time)$/i.test(column.trim()))
    || columns.find(column => /time|timestamp|datetime/i.test(column))
    || columns.find(column => /^date$/i.test(column.trim()))
    || columns.find(column => /date/i.test(column))
}

function inferUploadDate(columns: string[], rows: Record<string, string>[]) {
  const dateColumn = findTimeColumn(columns)
  if (dateColumn) {
    for (const row of rows) {
      const dateKey = normalizeDateKey(row[dateColumn])
      if (dateKey) return dateKey
    }
  }
  return todayKey()
}

function inferLogDate(fileName: unknown, columns: string[], rows: Record<string, string>[]) {
  const fileText = String(fileName || '').replace(/_/g, '-')
  const fileDate = fileText.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[-/\s][A-Za-z]{3,9}[-/\s]\d{2,4})/)
  const fromFile = normalizeDateKey(fileDate?.[1])
  if (fromFile) return fromFile
  return inferUploadDate(columns, rows)
}

function messageField(message: unknown, name: string) {
  const match = String(message || '').match(new RegExp(`${name}\\s*:\\s*([^;]+)`, 'i'))
  return match ? match[1].trim() : ''
}

function classifyLog(row: Record<string, string>) {
  const message = String(row.Message ?? row.message ?? '')
  const type = String(row['Log Type'] ?? row.logType ?? '').toUpperCase()
  if (type === 'ERROR' || /error|failed|rejected/i.test(message)) return 'ERROR'
  if (/adjust|modified|modify|shift|roll|re-?entry|trail/i.test(message)) return 'ADJUSTMENT'
  if (/Initiating Order Placement/i.test(message)) {
    if (/ExitSL:\s*True|stop\s*loss|\bSL\b/i.test(message)) return 'SL/EXIT'
    if (/IsExit:\s*True/i.test(message)) return 'EXIT ORDER'
    return 'ENTRY ORDER'
  }
  if (/ExitSL:\s*True|stop\s*loss|\bSL\b/i.test(message)) return 'SL/EXIT'
  if (/target/i.test(message) && !/Start Monitoring/i.test(message)) return 'TARGET'
  if (/IsExit:\s*True|square.?off|\bexit\b(?!\s*:\s*false)/i.test(message)) return 'EXIT'
  if (/OrderId:.*Placed/i.test(message)) return 'ORDER PLACED'
  if (/Option Portfolio .* Started/i.test(message)) return 'START'
  if (/Combined Premium/i.test(message)) return 'PREMIUM'
  if (/Start Monitoring/i.test(message)) return 'MONITORING'
  return type || 'MESSAGE'
}

async function journalPayload() {
  const csv = await readFile(MTM_CSV_FILE, 'utf8')
  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(await readFile(MTM_META_FILE, 'utf8')) as Record<string, unknown>
  } catch {
    const info = await stat(MTM_CSV_FILE)
    meta = {
      fileName: path.basename(MTM_CSV_FILE),
      updatedAt: info.mtime.toISOString(),
    }
  }
  const parsed = parseCsv(csv.replace(/^\uFEFF/, ''))
  return {
    ...parsed,
    meta: {
      fileName: String(meta.fileName || path.basename(MTM_CSV_FILE)),
      updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : null,
      uploadDate: typeof meta.uploadDate === 'string' ? meta.uploadDate : null,
      rows: parsed.rows.length,
    },
  }
}

async function listMtmDates() {
  const files = await readdir(PARQUET_DIR).catch(() => [])
  return files
    .map(file => file.match(/^mtm-(\d{4}-\d{2}-\d{2})\.parquet$/)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort()
    .reverse()
}

async function journalDatePayload(date: string) {
  const filePath = path.join(PARQUET_DIR, `mtm-${date}.parquet`)
  const data = await readParquet(filePath)
  const info = await stat(filePath)
  return {
    ...data,
    meta: {
      fileName: path.basename(filePath),
      updatedAt: info.mtime.toISOString(),
      uploadDate: date,
      loadedDate: date,
      rows: data.rows.length,
    },
  }
}

async function journalAllDatesPayload() {
  const dates = (await listMtmDates()).slice().reverse()
  const rows: Record<string, string>[] = []
  const columns = new Set<string>()
  let updatedAt: string | null = null

  for (const date of dates) {
    const filePath = path.join(PARQUET_DIR, `mtm-${date}.parquet`)
    const data = await readParquet(filePath)
    const info = await stat(filePath)
    if (!updatedAt || info.mtime.toISOString() > updatedAt) updatedAt = info.mtime.toISOString()
    for (const column of data.columns) columns.add(column)
    columns.add('__upload_date')
    for (const row of data.rows) rows.push({ ...row, __upload_date: row.__upload_date || date })
  }

  return {
    columns: [...columns],
    rows,
    meta: {
      fileName: 'All MTM dates',
      updatedAt,
      uploadDate: dates.at(-1) ?? null,
      loadedDate: dates.length ? `${dates[0]} to ${dates.at(-1)}` : '',
      rows: rows.length,
      dates,
      allDates: true,
    },
  }
}

async function readParquet(filePath: string) {
  const parquet = analyzerRequire('parquetjs-lite') as {
    ParquetReader: {
      openFile(filePath: string): Promise<{
        getCursor(): { next(): Promise<Record<string, unknown> | null> }
        close(): Promise<void>
      }>
    }
  }
  const reader = await parquet.ParquetReader.openFile(filePath)
  try {
    const cursor = reader.getCursor()
    const rows: Record<string, string>[] = []
    let record = await cursor.next()
    while (record) {
      rows.push(Object.fromEntries(Object.entries(record).map(([key, value]) => [key, String(value ?? '')])))
      record = await cursor.next()
    }
    return { columns: rows[0] ? Object.keys(rows[0]) : [], rows }
  } finally {
    await reader.close()
  }
}

async function exists(filePath: string) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function maxFinite(values: Array<number | null>) {
  let max: number | null = null
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue
    max = max === null || value > max ? value : max
  }
  return max
}

function makeParquetSchema(columns: string[]) {
  const parquet = analyzerRequire('parquetjs-lite') as {
    ParquetSchema: new (schema: Record<string, { type: string; optional: boolean }>) => unknown
  }
  return new parquet.ParquetSchema(Object.fromEntries(columns.map(column => [column, { type: 'UTF8', optional: true }])))
}

function normalizeRowsForColumns(rows: Record<string, string>[], columns: string[], uploadDate: string) {
  return rows.map(row => {
    const normalized: Record<string, string> = {}
    for (const column of columns) normalized[column] = String(row[column] ?? '')
    normalized.__upload_date = uploadDate
    normalized.__stored_at = normalized.__stored_at || new Date().toISOString()
    return normalized
  })
}

async function writeParquet(filePath: string, columns: string[], rows: Record<string, string>[]) {
  const parquet = analyzerRequire('parquetjs-lite') as {
    ParquetWriter: {
      openFile(schema: unknown, filePath: string): Promise<{
        appendRow(row: Record<string, string>): Promise<void>
        close(): Promise<void>
      }>
    }
  }
  const writer = await parquet.ParquetWriter.openFile(makeParquetSchema(columns), filePath)
  try {
    for (const row of rows) await writer.appendRow(row)
  } finally {
    await writer.close()
  }
}

async function saveUploadAsParquet(parsed: { columns: string[]; rows: Record<string, string>[] }, uploadDate: string, appendDuplicate: boolean) {
  const filePath = path.join(PARQUET_DIR, `mtm-${uploadDate}.parquet`)
  const alreadyExists = await exists(filePath)

  if (alreadyExists && !appendDuplicate) {
    return { duplicate: true, uploadDate, parquetFile: filePath }
  }

  const existing = appendDuplicate ? await readParquet(filePath) : { columns: [], rows: [] }
  const columns = [...new Set([...existing.columns, ...parsed.columns, '__upload_date', '__stored_at'])]
  const timeColumn = findTimeColumn(parsed.columns)
  const existingMaxTime = appendDuplicate && timeColumn
    ? maxFinite(existing.rows.map(row => parseTimestampMs(row[timeColumn])))
    : null
  const hasExistingMaxTime = existingMaxTime !== null && Number.isFinite(existingMaxTime)
  const sourceRows = appendDuplicate && timeColumn && hasExistingMaxTime
    ? parsed.rows.filter(row => {
      const rowTime = parseTimestampMs(row[timeColumn])
      return rowTime != null && rowTime > existingMaxTime
    })
    : parsed.rows
  const incomingRows = normalizeRowsForColumns(sourceRows, columns, uploadDate)
  const existingRows = normalizeRowsForColumns(existing.rows, columns, uploadDate)
  const rows = appendDuplicate ? [...existingRows, ...incomingRows] : incomingRows

  await writeParquet(filePath, columns, rows)

  return {
    duplicate: false,
    appended: alreadyExists && appendDuplicate,
    uploadDate,
    parquetFile: filePath,
    parquetRows: rows.length,
    appendedRows: incomingRows.length,
    skippedRows: appendDuplicate ? parsed.rows.length - incomingRows.length : 0,
    appendFromTime: appendDuplicate && hasExistingMaxTime ? new Date(existingMaxTime).toISOString() : null,
  }
}

function normalizeLogRows(rows: Record<string, string>[], columns: string[], uploadDate: string) {
  return rows.map((row, index) => {
    const message = String(row.Message ?? row.message ?? '')
    const normalized: Record<string, string> = {}
    for (const column of columns) normalized[column] = String(row[column] ?? '')
    normalized.Date = uploadDate
    normalized.Event = classifyLog(row)
    normalized.Index = String(index + 1)
    normalized.Symbol = messageField(message, 'Symbol')
    normalized.Qty = messageField(message, 'Qty')
    normalized.Txn = messageField(message, 'Txn')
    normalized.LegID = messageField(message, 'Leg ID') || messageField(message, 'LegId')
    normalized.OrderID = messageField(message, 'OrderId')
    normalized.IsExit = messageField(message, 'IsExit')
    normalized.ExitSL = messageField(message, 'ExitSL')
    normalized.__upload_date = uploadDate
    normalized.__stored_at = new Date().toISOString()
    return normalized
  })
}

function logSignature(row: Record<string, string>) {
  return [
    row.Date,
    row.Timestamp || row.Time || row.time || '',
    row['Strategy Tag'] || row.Strategy || '',
    row['Option Portfolio'] || '',
    row.Message || row.message || '',
    row.Symbol || '',
    row.Qty || '',
    row.Txn || '',
    row.LegID || '',
    row.OrderID || '',
  ].join('|')
}

async function saveLogsAsParquet(parsed: { columns: string[]; rows: Record<string, string>[] }, uploadDate: string, appendDuplicate: boolean) {
  const filePath = path.join(LOGS_DIR, `logs-${uploadDate}.parquet`)
  const alreadyExists = await exists(filePath)
  if (alreadyExists && !appendDuplicate) return { duplicate: true, uploadDate, parquetFile: filePath }

  const columns = [...new Set([
    ...parsed.columns,
    'Date',
    'Event',
    'Index',
    'Symbol',
    'Qty',
    'Txn',
    'LegID',
    'OrderID',
    'IsExit',
    'ExitSL',
    '__upload_date',
    '__stored_at',
  ])]
  const existing = appendDuplicate ? await readParquet(filePath) : { columns: [], rows: [] }
  const normalizedIncoming = normalizeLogRows(parsed.rows, columns, uploadDate)
  const normalizedExisting = normalizeLogRows(existing.rows, columns, uploadDate)
  const existingKeys = new Set(normalizedExisting.map(logSignature))
  const incomingRows = appendDuplicate ? normalizedIncoming.filter(row => !existingKeys.has(logSignature(row))) : normalizedIncoming
  const rows = appendDuplicate ? [...normalizedExisting, ...incomingRows] : normalizedIncoming

  await writeParquet(filePath, columns, rows)
  return {
    duplicate: false,
    appended: alreadyExists && appendDuplicate,
    uploadDate,
    parquetFile: filePath,
    parquetRows: rows.length,
    appendedRows: incomingRows.length,
    skippedRows: appendDuplicate ? normalizedIncoming.length - incomingRows.length : 0,
  }
}

async function latestLogDate() {
  const files = await readdir(LOGS_DIR).catch(() => [])
  return files
    .map(file => file.match(/^logs-(\d{4}-\d{2}-\d{2})\.parquet$/)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(-1) ?? ''
}

async function logsPayload(date?: string | null, strategy?: string | null) {
  const selectedDate = date || await latestLogDate()
  if (!selectedDate) return { columns: [], rows: [], meta: { fileName: '', date: '', rows: 0 } }

  const filePath = path.join(LOGS_DIR, `logs-${selectedDate}.parquet`)
  try {
    await access(filePath)
  } catch {
    return {
      columns: [],
      rows: [],
      meta: {
        fileName: path.basename(filePath),
        date: selectedDate,
        rows: 0,
        missing: true,
      },
    }
  }

  const data = await readParquet(filePath)
  const selectedStrategy = String(strategy || '').trim()
  const rows = selectedStrategy && selectedStrategy !== 'all'
    ? data.rows.filter(row => String(row['Strategy Tag'] || row.Strategy || '').trim() === selectedStrategy)
    : data.rows

  return {
    columns: data.columns,
    rows,
    meta: {
      fileName: path.basename(filePath),
      date: selectedDate,
      rows: rows.length,
    },
  }
}

async function latestSpotIvDate() {
  const files = await readdir(SPOT_IV_DIR).catch(() => [])
  return files
    .map(file => file.match(/^spot-iv-(\d{4}-\d{2}-\d{2})\.parquet$/)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(-1) ?? ''
}

async function listSpotIvDates() {
  const files = await readdir(SPOT_IV_DIR).catch(() => [])
  return files
    .map(file => file.match(/^spot-iv-(\d{4}-\d{2}-\d{2})\.parquet$/)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort()
}

async function spotIvPayload(date?: string | null) {
  const selectedDate = date || await latestSpotIvDate()
  if (!selectedDate) return { columns: [], rows: [], meta: { fileName: '', date: '', rows: 0 } }

  const filePath = path.join(SPOT_IV_DIR, `spot-iv-${selectedDate}.parquet`)
  try {
    await access(filePath)
  } catch {
    return {
      columns: [],
      rows: [],
      meta: {
        fileName: path.basename(filePath),
        date: selectedDate,
        rows: 0,
        missing: true,
      },
    }
  }

  const data = await readParquet(filePath)
  return {
    ...data,
    meta: {
      fileName: path.basename(filePath),
      date: selectedDate,
      rows: data.rows.length,
    },
  }
}

async function spotIvAllDatesPayload() {
  const dates = await listSpotIvDates()
  const rows: Record<string, string>[] = []
  const columns = new Set<string>()

  for (const date of dates) {
    const filePath = path.join(SPOT_IV_DIR, `spot-iv-${date}.parquet`)
    const data = await readParquet(filePath)
    for (const column of data.columns) columns.add(column)
    for (const row of data.rows) rows.push(row)
  }

  return {
    columns: [...columns],
    rows,
    meta: {
      fileName: dates.length ? `Spot/IV ${dates[0]} to ${dates.at(-1)}` : '',
      date: dates.length ? `${dates[0]} to ${dates.at(-1)}` : '',
      rows: rows.length,
      dates,
      allDates: true,
    },
  }
}

function parseSpotIvWorkbook(base64: string) {
  const xlsx = analyzerRequire('xlsx') as {
    read(buffer: Buffer, options: Record<string, unknown>): { Sheets: Record<string, unknown>; SheetNames: string[] }
    utils: { sheet_to_json(sheet: unknown, options: Record<string, unknown>): unknown[][] }
  }
  const workbook = xlsx.read(Buffer.from(base64, 'base64'), { type: 'buffer', cellDates: false })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('Spot IV workbook has no sheets')

  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: false })
  const oneColumnText = rows
    .map(row => Array.isArray(row) ? row[0] : '')
    .filter(value => value != null && String(value).trim() !== '')
    .join('\n')

  const parsedJson = (() => {
    try {
      return JSON.parse(oneColumnText) as SpotIvJson
    } catch {
      return null
    }
  })()

  if (parsedJson?.data?.ce?.time_s && parsedJson?.data?.pe?.time_s) {
    const ce = parsedJson.data.ce
    const pe = parsedJson.data.pe
    const len = Math.min(
      ce.time_s?.length || 0,
      pe.time_s?.length || 0,
      ce.spot?.length || 0,
      ce.iv?.length || 0,
      pe.iv?.length || 0,
    )

    const out: Record<string, string>[] = []
    for (let index = 0; index < len; index += 1) {
      const timeS = String(ce.time_s?.[index] || pe.time_s?.[index] || '')
      const dateKey = normalizeDateKey(timeS)
      if (!dateKey) continue
      const ceIv = Number(ce.iv?.[index])
      const peIv = Number(pe.iv?.[index])
      const spot = Number(ce.spot?.[index] ?? pe.spot?.[index])
      const ivValues = [ceIv, peIv].filter(Number.isFinite)
      const avgIv = ivValues.reduce((sum, value) => sum + value, 0) / ivValues.length
      out.push({
        date: dateKey,
        time_s: timeS,
        time_u: String(ce.time_u?.[index] ?? pe.time_u?.[index] ?? ''),
        spot: Number.isFinite(spot) ? String(spot) : '',
        ce_iv: Number.isFinite(ceIv) ? String(ceIv) : '',
        pe_iv: Number.isFinite(peIv) ? String(peIv) : '',
        avg_iv: Number.isFinite(avgIv) ? String(avgIv) : '',
        ce_strike: String(ce.strike?.[index] ?? ''),
        pe_strike: String(pe.strike?.[index] ?? ''),
      })
    }
    return out
  }

  const header = rows[0]?.map(value => String(value || '').trim()) || []
  const findColumn = (patterns: RegExp[]) => header.findIndex(name => patterns.some(pattern => pattern.test(name)))
  const dateIdx = findColumn([/date/i, /time/i])
  const spotIdx = findColumn([/spot/i, /underlying/i])
  const ivIdx = findColumn([/^iv$/i, /avg.*iv/i, /atm.*iv/i, /vol/i])
  if (dateIdx < 0 || spotIdx < 0 || ivIdx < 0) throw new Error('Could not find date/time, spot, and IV columns in Spot IV workbook')

  return rows.slice(1).map(row => {
    const timeS = String(row[dateIdx] || '')
    const dateKey = normalizeDateKey(timeS)
    return {
      date: dateKey,
      time_s: timeS,
      time_u: '',
      spot: String(row[spotIdx] ?? ''),
      ce_iv: '',
      pe_iv: '',
      avg_iv: String(row[ivIdx] ?? ''),
      ce_strike: '',
      pe_strike: '',
    }
  }).filter(row => row.date)
}

function groupByDate(rows: Record<string, string>[]) {
  const grouped = new Map<string, Record<string, string>[]>()
  for (const row of rows) {
    if (!grouped.has(row.date)) grouped.set(row.date, [])
    grouped.get(row.date)?.push(row)
  }
  return grouped
}

function spotIvRowTimeMs(row: Record<string, string>) {
  const unix = Number(row.time_u)
  if (Number.isFinite(unix) && unix > 0) return unix * 1000
  return parseTimestampMs(row.time_s)
}

async function saveSpotIvParquet(rows: Record<string, string>[], appendDuplicate: boolean) {
  await mkdir(SPOT_IV_DIR, { recursive: true })
  const grouped = groupByDate(rows)
  const duplicateDates: string[] = []
  for (const date of grouped.keys()) {
    if (await exists(path.join(SPOT_IV_DIR, `spot-iv-${date}.parquet`))) duplicateDates.push(date)
  }
  if (duplicateDates.length && !appendDuplicate) return { duplicate: true, duplicateDates, saved: [] }

  const columns = ['date', 'time_s', 'time_u', 'spot', 'ce_iv', 'pe_iv', 'avg_iv', 'ce_strike', 'pe_strike', '__stored_at']
  const saved = []
  for (const [date, dayRows] of grouped.entries()) {
    const filePath = path.join(SPOT_IV_DIR, `spot-iv-${date}.parquet`)
    const alreadyExists = await exists(filePath)
    const shouldAppendExisting = appendDuplicate && alreadyExists
    const existing = shouldAppendExisting ? await readParquet(filePath) : { rows: [] }
    const existingMaxTime = shouldAppendExisting
      ? maxFinite(existing.rows.map(row => spotIvRowTimeMs(row)))
      : null
    const hasExistingMaxTime = existingMaxTime !== null && Number.isFinite(existingMaxTime)
    const sourceRows = appendDuplicate && hasExistingMaxTime
      ? dayRows.filter(row => {
        const rowTime = spotIvRowTimeMs(row)
        return rowTime != null && rowTime > existingMaxTime
      })
      : dayRows
    const normalizedIncoming = sourceRows.map(row => ({
      ...Object.fromEntries(columns.map(column => [column, String(row[column] ?? '')])),
      __stored_at: new Date().toISOString(),
    }))
    const normalizedExisting = existing.rows.map(row => Object.fromEntries(columns.map(column => [column, String(row[column] ?? '')])))
    const nextRows = shouldAppendExisting ? [...normalizedExisting, ...normalizedIncoming] : normalizedIncoming
    await writeParquet(filePath, columns, nextRows)
    saved.push({
      date,
      rows: nextRows.length,
      file: path.basename(filePath),
      appended: shouldAppendExisting,
      appendedRows: normalizedIncoming.length,
      skippedRows: shouldAppendExisting ? dayRows.length - normalizedIncoming.length : 0,
      appendFromTime: shouldAppendExisting && hasExistingMaxTime ? new Date(existingMaxTime).toISOString() : null,
    })
  }
  return { duplicate: false, duplicateDates: [], saved }
}

function writeJson(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function journalApiPlugin() {
  async function handleMtm(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const allDates = url.searchParams.get('all') === '1'
      const date = String(url.searchParams.get('date') || '').trim()
      writeJson(res, 200, allDates ? await journalAllDatesPayload() : date ? await journalDatePayload(date) : await journalPayload())
    } catch (error) {
      writeJson(res, 500, { error: error instanceof Error ? error.message : 'Unable to load journal data' })
    }
  }

  async function handleDates(res: import('node:http').ServerResponse) {
    try {
      writeJson(res, 200, { dates: await listMtmDates() })
    } catch (error) {
      writeJson(res, 500, { error: error instanceof Error ? error.message : 'Unable to load MTM dates' })
    }
  }

  async function handleMtmUpload(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    try {
      const body = await readJsonBody(req)
      const csv = String(body.csv || '').replace(/^\uFEFF/, '')
      if (!csv.trim()) return writeJson(res, 400, { error: 'CSV is empty' })

      const parsed = parseCsv(csv)
      if (!parsed.columns.length) return writeJson(res, 400, { error: 'Could not read CSV columns' })

      const uploadDate = normalizeDateKey(body.uploadDate) || inferUploadDate(parsed.columns, parsed.rows)
      const parquetResult = await saveUploadAsParquet(parsed, uploadDate, body.appendDuplicate === true)

      if (parquetResult.duplicate) {
        return writeJson(res, 409, {
          error: `Data for ${uploadDate} already exists`,
          duplicate: true,
          uploadDate,
          message: `Data for ${uploadDate} already exists. Append only rows newer than the existing latest timestamp?`,
        })
      }

      const meta = {
        updatedAt: new Date().toISOString(),
        fileName: String(body.fileName || 'manual-upload.csv'),
        rows: parsed.rows.length,
        uploadDate,
        parquetRows: parquetResult.parquetRows,
        parquetFile: path.basename(parquetResult.parquetFile),
        appended: parquetResult.appended,
        appendedRows: parquetResult.appendedRows,
        skippedRows: parquetResult.skippedRows,
        appendFromTime: parquetResult.appendFromTime,
      }

      await writeFile(MTM_CSV_FILE, csv, 'utf8')
      await writeFile(MTM_META_FILE, JSON.stringify(meta, null, 2), 'utf8')
      return writeJson(res, 200, { ok: true, columns: parsed.columns, rows: parsed.rows, meta })
    } catch (error) {
      return writeJson(res, 500, { error: error instanceof Error ? error.message : 'MTM upload failed' })
    }
  }

  async function handleLogsUpload(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    try {
      const body = await readJsonBody(req)
      const csv = String(body.csv || '').replace(/^\uFEFF/, '')
      if (!csv.trim()) return writeJson(res, 400, { error: 'Log CSV is empty' })
      const parsed = parseCsv(csv)
      if (!parsed.columns.length) return writeJson(res, 400, { error: 'Could not read log CSV columns' })
      const uploadDate = normalizeDateKey(body.uploadDate) || inferLogDate(body.fileName, parsed.columns, parsed.rows)
      const result = await saveLogsAsParquet(parsed, uploadDate, body.appendDuplicate === true)

      if (result.duplicate) {
        return writeJson(res, 409, {
          error: `Logs for ${uploadDate} already exist`,
          duplicate: true,
          uploadDate,
          message: `Logs for ${uploadDate} already exist. Check this file and append only new log rows?`,
        })
      }

      return writeJson(res, 200, await logsPayload(uploadDate))
    } catch (error) {
      return writeJson(res, 500, { error: error instanceof Error ? error.message : 'Log upload failed' })
    }
  }

  async function handleSpotIvUpload(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    try {
      const body = await readJsonBody(req)
      const base64 = String(body.base64 || '')
      if (!base64) return writeJson(res, 400, { error: 'Spot/IV file is missing' })
      const rows = parseSpotIvWorkbook(base64)
      if (!rows.length) return writeJson(res, 400, { error: 'No Spot/IV rows found' })
      const result = await saveSpotIvParquet(rows, body.appendDuplicate === true)

      if (result.duplicate) {
        return writeJson(res, 409, {
          error: 'Spot/IV data already exists',
          duplicate: true,
          duplicateDates: result.duplicateDates,
          message: `Spot/IV data already exists for ${result.duplicateDates.join(', ')}. Check this file and append only rows newer than each existing latest timestamp?`,
        })
      }

      return writeJson(res, 200, { ok: true, fileName: String(body.fileName || 'spot-iv.xlsx'), saved: result.saved, rows: rows.length })
    } catch (error) {
      return writeJson(res, 500, { error: error instanceof Error ? error.message : 'Spot/IV upload failed' })
    }
  }

  async function handleLogs(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      writeJson(res, 200, await logsPayload(url.searchParams.get('date'), url.searchParams.get('strategy')))
    } catch (error) {
      writeJson(res, 500, { error: error instanceof Error ? error.message : 'Unable to load trade logs' })
    }
  }

  async function handleSpotIv(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const allDates = url.searchParams.get('all') === '1'
      writeJson(res, 200, allDates ? await spotIvAllDatesPayload() : await spotIvPayload(url.searchParams.get('date')))
    } catch (error) {
      writeJson(res, 500, { error: error instanceof Error ? error.message : 'Unable to load Spot/IV data' })
    }
  }

  return {
    name: 'alphahedge-journal-api',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/api/journal/dates', async (_req, res) => handleDates(res))
      server.middlewares.use('/api/journal/mtm/upload', async (req, res) => handleMtmUpload(req, res))
      server.middlewares.use('/api/journal/logs/upload', async (req, res) => handleLogsUpload(req, res))
      server.middlewares.use('/api/journal/spot-iv/upload', async (req, res) => handleSpotIvUpload(req, res))
      server.middlewares.use('/api/journal/mtm', async (req, res) => handleMtm(req, res))
      server.middlewares.use('/api/journal/logs', async (req, res) => handleLogs(req, res))
      server.middlewares.use('/api/journal/spot-iv', async (req, res) => handleSpotIv(req, res))
    },
    configurePreviewServer(server: import('vite').PreviewServer) {
      server.middlewares.use('/api/journal/dates', async (_req, res) => handleDates(res))
      server.middlewares.use('/api/journal/mtm/upload', async (req, res) => handleMtmUpload(req, res))
      server.middlewares.use('/api/journal/logs/upload', async (req, res) => handleLogsUpload(req, res))
      server.middlewares.use('/api/journal/spot-iv/upload', async (req, res) => handleSpotIvUpload(req, res))
      server.middlewares.use('/api/journal/mtm', async (req, res) => handleMtm(req, res))
      server.middlewares.use('/api/journal/logs', async (req, res) => handleLogs(req, res))
      server.middlewares.use('/api/journal/spot-iv', async (req, res) => handleSpotIv(req, res))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), journalApiPlugin()],
  server: {
    proxy: {
      '/api/auth': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      '/api/market': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
})
