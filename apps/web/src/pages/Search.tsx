import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useT } from '../i18n'
import { EmptyState, StatusPill, TaskKey, TypeIcon, useFormat } from '../ui'
import { Snippet, hitCount, isEmpty, type SearchResults } from '../search'

/**
 * Search results.
 *
 * The query lives in the address bar, so a result page can be shared and
 * the back button behaves.
 */
export default function Search() {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const t = useT()
  const fmt = useFormat()
  const navigate = useNavigate()
  const [draft, setDraft] = useState(query)
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => { setDraft(query) }, [query])

  const load = useCallback(async (q: string) => {
    if (!q.trim()) { setResults(null); return }
    setLoading(true)
    try {
      setResults(await api.get<SearchResults>(`/api/search?q=${encodeURIComponent(q)}&limit=30`))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(query) }, [query, load])

  // Debounced so the address bar does not churn on every keystroke
  const onType = (value: string) => {
    setDraft(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setParams(value.trim() ? { q: value } : {}, { replace: true })
    }, 300)
  }

  const openTask = (projectId: string, taskId: string) =>
    navigate(`/projects/${projectId}?task=${taskId}`)

  return (
    <div className="content-inner">
      <div className="page-head"><h2>{t('search.title')}</h2></div>

      <input
        className="input search-page-input"
        autoFocus
        value={draft}
        placeholder={t('nav.searchPlaceholder')}
        onChange={e => onType(e.target.value)}
      />

      {!query.trim() ? (
        <p className="search-hint">{t('search.hint')}</p>
      ) : loading && !results ? null : isEmpty(results) ? (
        <EmptyState illustrated title={t('search.empty', { q: query })} />
      ) : results && (
        <>
          <p className="search-hint">{t('search.count', { count: hitCount(results) })}</p>

          {results.tasks.length > 0 && (
            <>
              <div className="section-title">{t('search.tasks')}</div>
              <div className="card hit-list">
                {results.tasks.map(hit => (
                  <div key={hit.id} className="hit" onClick={() => openTask(hit.projectId, hit.id)}>
                    <div className="hit-line">
                      <TypeIcon type={hit.type} />
                      <TaskKey value={hit.key} />
                      <span className={`hit-title${hit.done ? ' done' : ''}`}>{hit.title}</span>
                      <span style={{ flex: 1 }} />
                      <StatusPill status={hit.status} />
                      <span className="hit-where">{hit.projectTitle}</span>
                    </div>
                    <Snippet text={hit.snippet} />
                  </div>
                ))}
              </div>
            </>
          )}

          {results.documents.length > 0 && (
            <>
              <div className="section-title">{t('search.documents')}</div>
              <div className="card hit-list">
                {results.documents.map(hit => (
                  <div key={hit.id} className="hit" onClick={() => navigate(`/projects/${hit.projectId}`)}>
                    <div className="hit-line">
                      <span className="hit-title">{hit.title}</span>
                      <span style={{ flex: 1 }} />
                      <span className="hit-where">{hit.projectTitle}</span>
                    </div>
                    <Snippet text={hit.snippet} />
                  </div>
                ))}
              </div>
            </>
          )}

          {results.comments.length > 0 && (
            <>
              <div className="section-title">{t('search.comments')}</div>
              <div className="card hit-list">
                {results.comments.map(hit => (
                  <div key={hit.id} className="hit" onClick={() => (hit.taskId
                    ? openTask(hit.projectId, hit.taskId)
                    : navigate(`/projects/${hit.projectId}`))}>
                    <div className="hit-line">
                      <span className="hit-title">
                        {hit.taskKey
                          ? t('search.inTask', { key: hit.taskKey })
                          : t('search.inDoc', { title: hit.parentTitle })}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span className="hit-where">
                        {hit.authorName} · {fmt.timeAgo(hit.createdAt)}
                      </span>
                    </div>
                    <Snippet text={hit.snippet} />
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
