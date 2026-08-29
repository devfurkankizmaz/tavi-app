import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { Avatar, DotsIcon, EmptyState, Markdown, Modal, Popover, PriorityChip, StatusPill, TaskKey, TrashIcon, TypeIcon, useAction, useFormat, useUndoableAction } from '../ui'
import { AssistBox, AssistButton, useAssist } from '../assist'
import type { DocDetail, DocSummary, ProjectDetail, Task } from '../types'

interface Props {
  project: ProjectDetail
  onOpenTask: (taskId: string) => void
}

/** Project docs: nested, linkable to tasks, and open to comments. */
export default function Documents({ project, onOpenTask }: Props) {
  const { me } = useApp()
  const t = useT()
  const fmt = useFormat()
  const run = useAction()
  const { agent } = useApp()
  const docSummary = useAssist<{ summary: string; points: string[] }>('/api/agent/summarize')
  const undoable = useUndoableAction()
  const canEdit = project.role !== 'VIEWER'

  const [list, setList] = useState<DocSummary[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [doc, setDoc] = useState<DocDetail | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [comment, setComment] = useState('')
  const [linking, setLinking] = useState(false)
  const [candidates, setCandidates] = useState<Task[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const loadList = useCallback(async () => {
    setList(await api.get<DocSummary[]>(`/api/projects/${project.id}/documents`))
  }, [project.id])

  const loadDoc = useCallback(async (id: string) => {
    const d = await api.get<DocDetail>(`/api/documents/${id}`)
    setDoc(d)
    setDraft(d.content)
    setEditing(false)
  }, [])

  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => { if (openId) void loadDoc(openId); else setDoc(null) }, [openId, loadDoc])

  const create = async (parentId: string | null) => {
    const title = window.prompt(t('docs.namePlaceholder'), '')
    if (!title?.trim()) return
    let created: { id: string } | null = null
    const ok = await run(async () => {
      created = await api.post<{ id: string }>(`/api/projects/${project.id}/documents`, { title: title.trim(), parentId })
    }, t('docs.created'))
    if (ok && created) { await loadList(); setOpenId((created as { id: string }).id) }
  }

  const save = () =>
    void run(async () => {
      await api.patch(`/api/documents/${doc!.id}`, { content: draft })
      await loadDoc(doc!.id)
      await loadList()
    }, t('docs.saved'))

  const addComment = async () => {
    const text = comment.trim()
    if (!text || !doc) return
    setComment('')
    await run(async () => { await api.post(`/api/documents/${doc.id}/comments`, { text }); await loadDoc(doc.id) })
  }

  const openLinking = async () => {
    if (!doc) return
    setPicked(new Set())
    setLinking(true)
    const all = await api.get<Task[]>(`/api/tasks?projectId=${project.id}&done=&take=200`)
    setCandidates(all.filter(x => !x.documentId))
  }

  const linkPicked = async () => {
    if (!doc || !picked.size) return
    const ok = await run(() => api.post(`/api/documents/${doc.id}/tasks`, { taskIds: [...picked] }))
    if (ok) { setLinking(false); await loadDoc(doc.id); await loadList() }
  }

  // Render the tree starting from the roots
  const childrenOf = (parentId: string | null) => list.filter(d => d.parentId === parentId)

  const renderTree = (parentId: string | null, depth = 0): React.ReactNode =>
    childrenOf(parentId).map(item => (
      <div key={item.id}>
        <button
          className={`doc-item${openId === item.id ? ' active' : ''}`}
          style={{ paddingLeft: `${0.55 + depth * 0.75}rem` }}
          onClick={() => setOpenId(item.id)}
        >
          <span className="doc-icon">{item.icon ?? '📄'}</span>
          <span className="grow">{item.title}</span>
          {item.taskCount > 0 && <span className="count">{item.taskCount}</span>}
        </button>
        {renderTree(item.id, depth + 1)}
      </div>
    ))

  return (
    <div className="docs">
      <aside className="docs-list">
        <div className="docs-list-head">
          <span>{t('docs.title')}</span>
          {canEdit && <button className="btn sm" onClick={() => create(null)}>+ {t('docs.new')}</button>}
        </div>
        {list.length === 0 && <p className="hint" style={{ padding: '0.8rem 0.5rem' }}>{t('docs.empty')}</p>}
        {renderTree(null)}
      </aside>

      <section className="docs-body card">
        {!doc ? (
          <EmptyState
            illustrated={list.length === 0}
            title={list.length === 0 ? t('empty.docs') : t('empty.docsPick')}
            body={list.length === 0 ? t('docs.empty') : t('docs.pickOne')}
            action={canEdit && list.length === 0
              ? <button className="btn primary" onClick={() => create(null)}>{t('docs.new')}</button>
              : undefined}
          />
        ) : (
          <>
            <div className="docs-head">
              <input
                className="doc-icon-input"
                value={doc.icon ?? ''}
                placeholder="📄"
                maxLength={4}
                disabled={!canEdit}
                aria-label={t('docs.icon')}
                onChange={e => setDoc({ ...doc, icon: e.target.value })}
                onBlur={e => void run(async () => {
                  await api.patch(`/api/documents/${doc.id}`, { icon: e.target.value || null })
                  await loadList()
                })}
              />
              <input
                className="doc-title-input"
                value={doc.title}
                disabled={!canEdit}
                aria-label={t('table.title')}
                onChange={e => setDoc({ ...doc, title: e.target.value })}
                onBlur={e => {
                  const value = e.target.value.trim()
                  if (value && value !== doc.title) {
                    void run(async () => {
                      await api.patch(`/api/documents/${doc.id}`, { title: value })
                      await loadList()
                    })
                  }
                }}
              />
              {canEdit && (
                <Popover align="right" trigger={<button className="icon-btn"><DotsIcon /></button>}>
                  {close => (
                    <>
                      <button className="row" onClick={() => { close(); void create(doc.id) }}>{t('docs.newChild')}</button>
                      <button className="row" style={{ color: 'var(--danger)' }} onClick={() => {
                        void undoable({
                          run: () => api.del(`/api/documents/${doc.id}`),
                          undo: () => api.post(`/api/trash/document/${doc.id}/restore`),
                          message: t('toast.docDeleted'),
                          onDone: () => { setOpenId(null); void loadList() },
                        })
                        close()
                      }}>{t('common.delete')}</button>
                    </>
                  )}
                </Popover>
              )}
            </div>

            <div className="docs-meta">
              {doc.author && <><Avatar user={doc.author} size={18} /> {doc.author.name} · </>}
              {t('docs.updated', { when: fmt.timeAgo(doc.updatedAt) })}
              {agent.enabled && doc.content.trim().length > 400 && (
                <AssistButton
                  label={t('assist.summarize')}
                  busy={docSummary.loading}
                  onClick={() => void docSummary.run({ kind: 'document', id: doc.id })}
                />
              )}
            </div>

            {(docSummary.data || docSummary.error) && (
              <AssistBox title={t('assist.summaryTitle')} error={docSummary.error} onDismiss={docSummary.reset}>
                <p className="assist-summary">{docSummary.data?.summary}</p>
                {docSummary.data?.points.length ? (
                  <ul className="assist-points">
                    {docSummary.data.points.map(point => <li key={point}>{point}</li>)}
                  </ul>
                ) : null}
              </AssistBox>
            )}

            {editing ? (
              <div>
                <textarea className="input doc-editor" value={draft} autoFocus
                  placeholder={t('docs.contentPlaceholder')}
                  onChange={e => setDraft(e.target.value)} />
                <div className="desc-actions">
                  <button className="btn primary sm" onClick={save}>{t('common.save')}</button>
                  <button className="btn ghost sm" onClick={() => { setDraft(doc.content); setEditing(false) }}>
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : doc.content.trim() ? (
              <div onClick={() => canEdit && setEditing(true)} style={{ cursor: canEdit ? 'text' : 'default' }}>
                <Markdown text={doc.content} />
              </div>
            ) : (
              <div className="desc-placeholder" onClick={() => canEdit && setEditing(true)}>
                {canEdit ? t('docs.contentPlaceholder') : t('task.noDescription')}
              </div>
            )}

            {doc.children.length > 0 && (
              <>
                <div className="subhead">{t('docs.subPages')}</div>
                {doc.children.map(child => (
                  <button key={child.id} className="doc-item" onClick={() => setOpenId(child.id)}>
                    <span className="doc-icon">{child.icon ?? '📄'}</span>
                    <span className="grow">{child.title}</span>
                  </button>
                ))}
              </>
            )}

            <div className="subhead">
              {t('docs.linkedTasks')} <span className="chip count">{doc.tasks.length}</span>
              {canEdit && <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={openLinking}>+ {t('docs.linkTask')}</button>}
            </div>
            {doc.tasks.map(task => (
              <div key={task.id} className="doc-task" onClick={() => onOpenTask(task.id)}>
                <TypeIcon type={task.type} />
                <TaskKey value={task.key} />
                <StatusPill status={task.status} />
                <span className="grow">{task.title}</span>
                <PriorityChip priority={task.priority} />
                {canEdit && (
                  <button className="del" onClick={e => {
                    e.stopPropagation()
                    void run(async () => {
                      await api.del(`/api/documents/${doc.id}/tasks/${task.id}`)
                      await loadDoc(doc.id)
                      await loadList()
                    })
                  }} aria-label={t('docs.unlink')}><TrashIcon /></button>
                )}
              </div>
            ))}

            <div className="subhead">
              {t('task.comments')} <span className="chip count">{doc.comments.length}</span>
            </div>
            {doc.comments.map(c => (
              <div key={c.id} className="comment">
                {c.author ? <Avatar user={c.author} size={24} /> : <span className="avatar" style={{ width: 24, height: 24 }}>?</span>}
                <div className="body">
                  <div className="head">
                    <span className="who">{c.author?.name ?? t('task.deletedUser')}</span>
                    <span className="when">{fmt.timeAgo(c.createdAt)}</span>
                    {c.author?.id === me.id && (
                      <span className="actions">
                        <button onClick={() =>
                          void run(async () => { await api.del(`/api/comments/${c.id}`); await loadDoc(doc.id) })
                        }>{t('common.delete')}</button>
                      </span>
                    )}
                  </div>
                  <Markdown text={c.text} />
                </div>
              </div>
            ))}
            {canEdit && (
              <div className="inline-add">
                <input className="input sm" placeholder={t('task.commentPlaceholder')} value={comment}
                  onChange={e => setComment(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void addComment() }} />
              </div>
            )}
          </>
        )}
      </section>

      {linking && doc && (
        <Modal title={t('docs.linkTask')} onClose={() => setLinking(false)} wide>
          <p className="hint" style={{ marginBottom: '0.6rem' }}>{t('docs.candidates')}</p>
          <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
            {candidates.length === 0 && <div className="empty">{t('common.noResults')}</div>}
            {candidates.map(task => (
              <label key={task.id} className="pick-row">
                <input type="checkbox" checked={picked.has(task.id)} onChange={e =>
                  setPicked(prev => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(task.id); else next.delete(task.id)
                    return next
                  })
                } />
                <TaskKey value={task.key} />
                <span className="grow">{task.title}</span>
                <StatusPill status={task.status} />
              </label>
            ))}
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => setLinking(false)}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={linkPicked} disabled={!picked.size}>
              {t('docs.linkTask')} ({picked.size})
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
