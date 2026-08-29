import { useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { EmptyState, LabelChip, useAction } from '../ui'

const PALETTE = ['#ad6608', '#2b8a5e', '#c8352f', '#2f6fa8', '#8e4ec6', '#0e8f9e', '#8a8278']

export default function Labels() {
  const { labels, refreshLabels } = useApp()
  const t = useT()
  const run = useAction()
  const [title, setTitle] = useState('')
  const [color, setColor] = useState(PALETTE[0])

  const create = async () => {
    const value = title.trim()
    if (!value) return
    const ok = await run(() => api.post('/api/labels', { title: value, color }), t('labels.created'))
    if (ok) { setTitle(''); await refreshLabels() }
  }

  return (
    <div className="content-inner">
      <div className="page-head"><h2>{t('labels.title')}</h2></div>

      <div className="card" style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.45rem', marginBottom: '1.2rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder={t('labels.new')} value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void create() }} />
          {PALETTE.map(c => (
            <button key={c} onClick={() => setColor(c)} aria-label={c}
              style={{
                width: 22, height: 22, borderRadius: 7, background: c, border: 'none',
                outline: color === c ? '2px solid var(--text)' : 'none', outlineOffset: 2,
              }} />
          ))}
          <button className="btn primary" onClick={create}>{t('common.add')}</button>
        </div>

        {labels.length === 0 && <EmptyState title={t('empty.labels')} body={t('labels.empty')} />}
        {labels.map(label => (
          <div key={label.id} className="member-row">
            <LabelChip label={label} />
            <span className="grow" />
            <input type="color" value={label.color} aria-label={t('task.color')}
              onChange={e => void run(async () => {
                await api.patch(`/api/labels/${label.id}`, { color: e.target.value })
                await refreshLabels()
              })}
              style={{ width: 28, height: 22, border: 'none', background: 'none', padding: 0 }} />
            <button className="btn ghost sm" onClick={() => {
              const value = window.prompt(t('labels.name'), label.title)
              if (value?.trim()) {
                void run(async () => {
                  await api.patch(`/api/labels/${label.id}`, { title: value.trim() })
                  await refreshLabels()
                })
              }
            }}>{t('common.rename')}</button>
            <button className="btn ghost sm danger" onClick={() => {
              if (window.confirm(t('labels.deleteConfirm', { title: label.title }))) {
                void run(async () => { await api.del(`/api/labels/${label.id}`); await refreshLabels() })
              }
            }}>{t('common.delete')}</button>
          </div>
        ))}
      </div>
    </div>
  )
}
