/**
 * Importing an export file.
 *
 * The file is read in the browser and posted as JSON rather than uploaded,
 * so a file that is not an export fails here — with a sentence about why —
 * instead of arriving at the server as a rejected upload.
 */
import { useRef, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { FormError, useToast } from '../ui'

/** Matches the parser mounted on the import route. */
const MAX_BYTES = 25 * 1024 * 1024

interface Report {
  projects: number
  tasks: number
  documents: number
  comments: number
  labels: number
  unmatchedPeople: number
  skipped: string[]
}

/** Only the four numbers the sentence mentions; `t` takes a flat record. */
const counts = (r: Report) => ({
  projects: r.projects, tasks: r.tasks, documents: r.documents, comments: r.comments,
})

export default function ImportPanel({ onDone }: { onDone: () => void }) {
  const t = useT()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<Report | null>(null)

  const pick = (chosen: File | null) => {
    setError(null)
    setReport(null)
    if (chosen && chosen.size > MAX_BYTES) {
      setFile(null)
      setError(t('import.tooBig'))
      return
    }
    setFile(chosen)
  }

  const start = async () => {
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      const text = await file.text()
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        setError(t('import.notJson'))
        return
      }
      const result = await api.post<Report>('/api/import', payload)
      setReport(result)
      setFile(null)
      if (input.current) input.current.value = ''
      toast(t('import.done', counts(result)))
      // Projects appear in the sidebar only once the store reloads.
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section">
      <h3>{t('import.title')}</h3>
      <p>{t('import.intro')}</p>
      <p className="settings-note">{t('import.warnRepeat')}</p>

      <div className="row gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          ref={input}
          type="file"
          className="import-file"
          accept="application/json,.json"
          aria-label={t('import.pick')}
          onChange={e => pick(e.target.files?.[0] ?? null)}
        />
        <button className="btn sm" disabled={!file || busy} onClick={() => void start()}>
          {t('import.run')}
        </button>
      </div>

      <FormError message={error} />

      {report && (
        <div className="settings-note" style={{ marginTop: '0.7rem' }}>
          <p>{t('import.done', counts(report))}</p>
          {report.labels > 0 && <p>{t('import.newLabels', { count: report.labels })}</p>}
          {report.unmatchedPeople > 0 && <p>{t('import.unmatched', { count: report.unmatchedPeople })}</p>}
          {report.skipped.length > 0 && <p>{t('import.skipped', { list: report.skipped.join('; ') })}</p>}
        </div>
      )}
    </div>
  )
}
