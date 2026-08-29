import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import {
  Avatar, AvatarStack, Checkbox, CloseIcon, DueChip, LabelChip, Markdown, Popover,
  PriorityChip, Star, StatusSelect, TaskKey, TrashIcon, fromLocalInput, toLocalInput,
  TypeIcon, TypeSelect, useAction, useFormat, usePriorityLabel, useStatusLabel,
  useTypeLabel, useUndoableAction,
} from '../ui'
import type { TaskDetail, Task, User, ProjectDetail, ActivityItem, TaskStatus, TaskType } from '../types'
import { TYPE_TEMPLATES } from '../types'
import { AssistBox, AssistButton, useAssist } from '../assist'

interface Props {
  taskId: string
  project: ProjectDetail | null
  onClose: () => void
  onChanged: () => void
  onOpenTask: (id: string) => void
}

export default function TaskPanel({ taskId, project, onClose, onChanged, onOpenTask }: Props) {
  const { me, labels, cycles, refreshLabels } = useApp()
  const t = useT()
  const fmt = useFormat()
  const priorityLabel = usePriorityLabel()
  const typeLabel = useTypeLabel()
  const { agent } = useApp()

  // Assistant suggestions are a draft; only what you tick gets created
  const subtaskAssist = useAssist<{ subtasks: { title: string; type: TaskType; why: string }[] }>('/api/agent/suggest-subtasks')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const summaryAssist = useAssist<{ summary: string; points: string[] }>('/api/agent/summarize')
  const statusLabel = useStatusLabel()
  const run = useAction()
  const undoable = useUndoableAction()
  const [task, setTask] = useState<TaskDetail | null>(null)
  const [editingDesc, setEditingDesc] = useState(false)
  const [desc, setDesc] = useState('')
  const [comment, setComment] = useState('')
  const [subTitle, setSubTitle] = useState('')
  const [relSearch, setRelSearch] = useState('')
  const [relResults, setRelResults] = useState<Task[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setTask(await api.get<TaskDetail>(`/api/tasks/${taskId}`))
  }, [taskId])

  useEffect(() => {
    setEditingDesc(false)
    void load().then(() => setDesc(''))
  }, [load])

  useEffect(() => { if (task) setDesc(task.description) }, [task?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === 'Escape' && !typing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (relSearch.trim().length < 2) { setRelResults([]); return }
    const timer = setTimeout(async () => {
      setRelResults(await api.get<Task[]>(`/api/tasks?q=${encodeURIComponent(relSearch)}&take=6`))
    }, 250)
    return () => clearTimeout(timer)
  }, [relSearch])

  if (!task) return null
  const canEdit = task.role !== 'VIEWER'

  const mutate = (body: Record<string, unknown>, okMsg?: string) =>
    run(async () => { await api.patch(`/api/tasks/${task.id}`, body); await load(); onChanged() }, okMsg)

  const memberPool: User[] = project
    ? [project.owner, ...project.members.map(m => m.user)].filter((u, i, arr) => arr.findIndex(x => x.id === u.id) === i)
    : [me]

  const toggleAssignee = (user: User) => {
    const has = task.assignees.some(a => a.id === user.id)
    const next = has
      ? task.assignees.filter(a => a.id !== user.id).map(a => a.id)
      : [...task.assignees.map(a => a.id), user.id]
    void mutate({ assigneeIds: next })
  }

  const toggleLabel = (labelId: string) => {
    const has = task.labels.some(l => l.id === labelId)
    const next = has
      ? task.labels.filter(l => l.id !== labelId).map(l => l.id)
      : [...task.labels.map(l => l.id), labelId]
    void mutate({ labelIds: next })
  }

  const quickCreateLabel = (title: string) =>
    run(async () => {
      const label = await api.post<{ id: string }>('/api/labels', { title })
      await api.patch(`/api/tasks/${task.id}`, { labelIds: [...task.labels.map(l => l.id), label.id] })
      await refreshLabels()
      await load()
      onChanged()
    })

  const toggleFavorite = () =>
    run(async () => {
      if (task.isFavorite) await api.del(`/api/favorites/task/${task.id}`)
      else await api.post('/api/favorites', { kind: 'task', targetId: task.id })
      await load()
    })

  const addComment = async () => {
    const text = comment.trim()
    if (!text) return
    setComment('')
    await run(async () => { await api.post(`/api/tasks/${task.id}/comments`, { text }); await load() })
  }

  /** Creates the picked suggestions one by one, so their order survives. */
  const addPicked = async () => {
    const items = (subtaskAssist.data?.subtasks ?? []).filter(x => picked.has(x.title))
    if (!items.length) return
    await run(async () => {
      for (const item of items) {
        await api.post(`/api/projects/${task!.projectId}/tasks`, {
          title: item.title, type: item.type, parentId: task!.id,
        })
      }
      subtaskAssist.reset()
      setPicked(new Set())
      await load()
      onChanged()
    })
  }

  const addSubtask = async () => {
    const value = subTitle.trim()
    if (!value) return
    setSubTitle('')
    await run(async () => {
      await api.post(`/api/projects/${task.projectId}/tasks`, { title: value, parentId: task.id })
      await load()
      onChanged()
    })
  }

  const addReminder = () => {
    const inOneHour = new Date(Date.now() + 3600_000).toISOString()
    void mutate({ reminders: [...task.reminders.map(r => r.remindAt), inOneHour] })
  }

  return (
    <>
      <div className="panel-backdrop" onMouseDown={onClose} />
      <aside className="task-panel" role="dialog" aria-modal="true" aria-label={task.title}>
        <div className="task-panel-head">
          <Checkbox on={task.done} onToggle={() => void mutate({ done: !task.done })} />
          <TaskKey value={task.key} />
          <StatusSelect status={task.status} disabled={!canEdit}
            onChange={next => void mutate({ status: next })} />
          <TypeSelect type={task.type} disabled={!canEdit}
            onChange={next => void mutate({ type: next })} />
          {task.repeatAfter > 0 && <span className="chip count" title={t('task.repeating')}>🔁</span>}
          <span style={{ flex: 1 }} />
          <button
            className={`btn sm ghost${task.isWatching ? ' on' : ''}`}
            title={t('task.watchHint')}
            onClick={() => void run(async () => {
              if (task.isWatching) await api.del(`/api/tasks/${task.id}/watch`)
              else await api.post(`/api/tasks/${task.id}/watch`)
              await load()
            })}
          >{task.isWatching ? t('task.unwatch') : t('task.watch')}</button>
          <Star on={!!task.isFavorite} onToggle={() => void toggleFavorite()} />
          {canEdit && (
            <button
              className="icon-btn"
              title={t('task.deleteTask')}
              aria-label={t('task.deleteTask')}
              onClick={() => void undoable({
                run: () => api.del(`/api/tasks/${task.id}`),
                undo: () => api.post(`/api/trash/task/${task.id}/restore`),
                message: t('toast.taskDeleted'),
                onDone: onChanged,
              }).then(ok => { if (ok) onClose() })}
            ><TrashIcon /></button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}><CloseIcon /></button>
        </div>

        <div className="task-panel-body">
          <input
            className="task-title-input"
            value={task.title}
            disabled={!canEdit}
            aria-label={t('table.title')}
            onChange={e => setTask({ ...task, title: e.target.value })}
            onBlur={e => {
              const value = e.target.value.trim()
              if (value && value !== task.title) void mutate({ title: value })
            }}
          />

          {task.parent && (
            <div className="hint" style={{ marginBottom: '0.6rem' }}>
              {t('task.parent')}:{' '}
              <a style={{ cursor: 'pointer' }} onClick={() => onOpenTask(task.parent!.id)}>
                #{task.parent.number} {task.parent.title}
              </a>
            </div>
          )}

          <div className="prop-grid">
            <label>{t('task.assignees')}</label>
            <div className="val">
              <AvatarStack users={task.assignees} />
              {canEdit && (
                <Popover trigger={<button className="btn sm ghost">+ {t('task.assign')}</button>}>
                  {() => (
                    <>
                      {memberPool.map(user => (
                        <button key={user.id}
                          className={`row${task.assignees.some(a => a.id === user.id) ? ' on' : ''}`}
                          onClick={() => toggleAssignee(user)}>
                          <Avatar user={user} size={22} static /> {user.name}
                        </button>
                      ))}
                    </>
                  )}
                </Popover>
              )}
            </div>

            <label>{t('task.labels')}</label>
            <div className="val">
              {task.labels.map(l => (
                <LabelChip key={l.id} label={l} onRemove={canEdit ? () => toggleLabel(l.id) : undefined} />
              ))}
              {canEdit && (
                <LabelPicker
                  labels={labels}
                  active={task.labels.map(l => l.id)}
                  onToggle={toggleLabel}
                  onCreate={quickCreateLabel}
                />
              )}
            </div>

            <label>{t('task.priority')}</label>
            <div className="val">
              {canEdit ? (
                <select value={task.priority} onChange={e => void mutate({ priority: Number(e.target.value) })}>
                  <option value={0}>{t('common.none')}</option>
                  {[1, 2, 3, 4, 5].map(p => <option key={p} value={p}>{priorityLabel(p)}</option>)}
                </select>
              ) : <PriorityChip priority={task.priority} />}
            </div>

            <label>{t('task.estimate')}</label>
            <div className="val">
              <input type="number" min={0} max={999} disabled={!canEdit}
                value={task.estimate ?? ''} placeholder="—" style={{ width: 78 }}
                onChange={e => setTask({ ...task, estimate: e.target.value === '' ? null : Number(e.target.value) })}
                onBlur={e => void mutate({ estimate: e.target.value === '' ? null : Number(e.target.value) })} />
              <span className="hint">{t('task.points', { count: task.estimate ?? 0 })}</span>
            </div>

            <label>{t('task.cycle')}</label>
            <div className="val">
              {canEdit ? (
                <select value={task.cycleId ?? ''} onChange={e => void mutate({ cycleId: e.target.value || null })}>
                  <option value="">{t('cycle.none')}</option>
                  {cycles.filter(c => !c.closedAt).map(c => (
                    <option key={c.id} value={c.id}>{c.name} · {c.team.name}</option>
                  ))}
                </select>
              ) : <span className="hint">{task.cycle?.name ?? t('cycle.none')}</span>}
            </div>

            <label>{t('task.start')}</label>
            <div className="val">
              <input type="datetime-local" disabled={!canEdit} value={toLocalInput(task.startDate)}
                onChange={e => void mutate({ startDate: fromLocalInput(e.target.value) })} />
            </div>

            <label>{t('task.due')}</label>
            <div className="val">
              <input type="datetime-local" disabled={!canEdit} value={toLocalInput(task.dueDate)}
                onChange={e => void mutate({ dueDate: fromLocalInput(e.target.value) })} />
              <DueChip dueDate={task.dueDate} done={task.done} />
            </div>

            <label>{t('task.progress')}</label>
            <div className="val">
              <input type="range" min={0} max={100} step={10} disabled={!canEdit}
                value={task.percentDone}
                onChange={e => setTask({ ...task, percentDone: Number(e.target.value) })}
                onMouseUp={() => void mutate({ percentDone: task.percentDone })}
                onTouchEnd={() => void mutate({ percentDone: task.percentDone })} />
              <span className="hint">%{task.percentDone}</span>
            </div>

            <label>{t('task.repeat')}</label>
            <div className="val">
              {canEdit ? (
                <select value={task.repeatAfter} onChange={e => void mutate({ repeatAfter: Number(e.target.value) })}>
                  <option value={0}>{t('task.noRepeat')}</option>
                  <option value={86400}>{t('task.daily')}</option>
                  <option value={604800}>{t('task.weekly')}</option>
                  <option value={1209600}>{t('task.biweekly')}</option>
                  <option value={2592000}>{t('task.monthly')}</option>
                </select>
              ) : <span className="hint">{task.repeatAfter ? t('task.repeating') : t('common.none')}</span>}
              {canEdit && <span className="hint">{t('task.repeatHint')}</span>}
            </div>

            <label>{t('task.reminders')}</label>
            <div className="val">
              {task.reminders.map((r, i) => (
                <span key={r.id} className="chip count">
                  {fmt.dateTime(r.remindAt)}
                  {canEdit && (
                    <button className="chip-x" onClick={() =>
                      void mutate({ reminders: task.reminders.filter((_, j) => j !== i).map(x => x.remindAt) })
                    }>×</button>
                  )}
                </span>
              ))}
              {canEdit && <button className="btn sm ghost" onClick={addReminder}>+ {t('common.add')}</button>}
            </div>

            <label>{t('task.color')}</label>
            <div className="val">
              <input type="color" disabled={!canEdit} value={task.color ?? '#c3a183'}
                onChange={e => void mutate({ color: e.target.value })} aria-label={t('task.color')} />
              {task.color && canEdit && (
                <button className="btn sm ghost" onClick={() => void mutate({ color: null })}>{t('common.clear')}</button>
              )}
            </div>
          </div>

          <div className="subhead">{t('task.description')}</div>
          {editingDesc ? (
            <div>
              <textarea className="input" rows={7} value={desc} onChange={e => setDesc(e.target.value)}
                placeholder={t('task.descPlaceholder')} autoFocus />
              <div className="desc-actions">
                <button className="btn primary sm" onClick={() =>
                  void mutate({ description: desc }).then(() => setEditingDesc(false))
                }>{t('common.save')}</button>
                <button className="btn ghost sm" onClick={() => { setDesc(task.description); setEditingDesc(false) }}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : task.description.trim() ? (
            <div onClick={() => canEdit && setEditingDesc(true)} style={{ cursor: canEdit ? 'pointer' : 'default' }}>
              <Markdown text={task.description} />
            </div>
          ) : (
            <div className="desc-placeholder" onClick={() => canEdit && setEditingDesc(true)}>
              {canEdit ? t('task.addDescription') : t('task.noDescription')}
              {canEdit && TYPE_TEMPLATES[task.type] && (
                <button className="btn ghost sm" onClick={e => {
                  e.stopPropagation()
                  setDesc(TYPE_TEMPLATES[task.type])
                  setEditingDesc(true)
                }}>{t('type.template', { type: typeLabel(task.type) })}</button>
              )}
            </div>
          )}

          <div className="subhead">
            {t('task.subtasks')} <span className="chip count">{task.subtasks.length}</span>
          </div>
          {task.subtasks.map(sub => (
            <div key={sub.id} className="subtask-row" onClick={() => onOpenTask(sub.id)}>
              <Checkbox on={sub.done} onToggle={() =>
                void run(async () => { await api.patch(`/api/tasks/${sub.id}`, { done: !sub.done }); await load(); onChanged() })
              } />
              <span style={{ flex: 1, textDecoration: sub.done ? 'line-through' : 'none', color: sub.done ? 'var(--muted)' : undefined }}>
                #{sub.number} {sub.title}
              </span>
              <AvatarStack users={sub.assignees} size={20} />
            </div>
          ))}
          {canEdit && (
            <div className="inline-add">
              <input className="input sm" placeholder={t('task.addSubtask')} value={subTitle}
                onChange={e => setSubTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void addSubtask() }} />
              {agent.enabled && (
                <AssistButton
                  label={t('assist.suggestSubtasks')}
                  busy={subtaskAssist.loading}
                  onClick={() => { setPicked(new Set()); void subtaskAssist.run({ taskId: task.id }) }}
                />
              )}
            </div>
          )}

          {canEdit && (subtaskAssist.data || subtaskAssist.error) && (
            <AssistBox
              title={t('assist.subtasksTitle')}
              error={subtaskAssist.error}
              onDismiss={() => { subtaskAssist.reset(); setPicked(new Set()) }}
              actions={picked.size > 0 && (
                <button className="btn primary sm" onClick={() => void addPicked()}>
                  {t('assist.addSelected', { count: picked.size })}
                </button>
              )}
            >
              {subtaskAssist.data?.subtasks.length
                ? subtaskAssist.data.subtasks.map(item => (
                    <label key={item.title} className="assist-item">
                      <input type="checkbox" checked={picked.has(item.title)} onChange={() => setPicked(prev => {
                        const next = new Set(prev)
                        if (next.has(item.title)) next.delete(item.title)
                        else next.add(item.title)
                        return next
                      })} />
                      <TypeIcon type={item.type} />
                      <span className="grow">{item.title}</span>
                      <span className="why">{item.why}</span>
                    </label>
                  ))
                : <p className="assist-empty">{t('assist.nothingToAdd')}</p>}
            </AssistBox>
          )}

          <div className="subhead">
            {t('task.relations')} <span className="chip count">{task.relations.length}</span>
            {task.blockedBy > 0 && !task.done && (
              <span className="chip blocked">{t('task.blockedBy', { count: task.blockedBy })}</span>
            )}
          </div>
          {task.relations.map(rel => (
            <div key={rel.id} className="subtask-row">
              <span className="chip count">
                {rel.kind === 'blocks' ? t('task.relation.blocks')
                  : rel.kind === 'blocked_by' ? t('task.relation.blocked_by')
                  : t('task.relation.related')}
              </span>
              <span style={{ flex: 1, cursor: 'pointer' }} onClick={() => onOpenTask(rel.task.id)}>
                #{rel.task.number} {rel.task.title}
              </span>
              {canEdit && (
                <button className="chip-x" onClick={() =>
                  void run(async () => { await api.del(`/api/relations/${rel.id}`); await load() })
                }>×</button>
              )}
            </div>
          ))}
          {canEdit && (
            <div style={{ position: 'relative' }}>
              <input className="input sm" placeholder={t('task.relateSearch')} value={relSearch}
                onChange={e => setRelSearch(e.target.value)} />
              {relResults.length > 0 && (
                <div className="search-results" style={{ top: 38 }}>
                  {relResults.filter(x => x.id !== task.id).map(x => (
                    <div key={x.id} className="row" onClick={() => {
                      setRelSearch('')
                      setRelResults([])
                      void run(async () => {
                        await api.post(`/api/tasks/${task.id}/relations`, { toId: x.id, kind: 'related' })
                        await load()
                      })
                    }}>#{x.number} {x.title}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="subhead">
            {t('task.attachments')} <span className="chip count">{task.attachments.length}</span>
          </div>
          {task.attachments.map(file => (
            <div key={file.id} className="attach-row">
              <a href={`/api/attachments/${file.id}/download`} target="_blank" rel="noreferrer">{file.fileName}</a>
              <span className="size">{fmt.bytes(file.size)}</span>
              {canEdit && (
                <button className="chip-x" onClick={() =>
                  void run(async () => { await api.del(`/api/attachments/${file.id}`); await load() })
                }>×</button>
              )}
            </div>
          ))}
          {canEdit && (
            <>
              <input ref={fileInput} type="file" hidden onChange={e => {
                const file = e.target.files?.[0]
                if (file) {
                  void run(async () => { await api.upload(`/api/tasks/${task.id}/attachments`, file); await load() }, t('task.uploadedToast'))
                }
                e.target.value = ''
              }} />
              <button className="btn sm ghost" onClick={() => fileInput.current?.click()}>+ {t('task.uploadFile')}</button>
            </>
          )}

          <div className="subhead">
            {t('task.comments')} <span className="chip count">{task.comments.length}</span>
            {agent.enabled && task.comments.length >= 3 && (
              <AssistButton
                label={t('assist.summarize')}
                busy={summaryAssist.loading}
                onClick={() => void summaryAssist.run({ kind: 'task', id: task.id })}
              />
            )}
          </div>
          {(summaryAssist.data || summaryAssist.error) && (
            <AssistBox
              title={t('assist.summaryTitle')}
              error={summaryAssist.error}
              onDismiss={summaryAssist.reset}
            >
              <p className="assist-summary">{summaryAssist.data?.summary}</p>
              {summaryAssist.data?.points.length ? (
                <ul className="assist-points">
                  {summaryAssist.data.points.map(point => <li key={point}>{point}</li>)}
                </ul>
              ) : null}
            </AssistBox>
          )}
          {task.comments.map(c => (
            <div key={c.id} className="comment">
              {c.author
                ? <Avatar user={c.author} size={26} />
                : <span className="avatar" style={{ width: 26, height: 26, fontSize: 11 }}>?</span>}
              <div className="body">
                <div className="head">
                  <span className="who">{c.author?.name ?? t('task.deletedUser')}</span>
                  <span className="when">{fmt.timeAgo(c.createdAt)}</span>
                  {c.author?.id === me.id && (
                    <span className="actions">
                      <button onClick={() => {
                        const next = window.prompt(t('task.editComment'), c.text)
                        if (next?.trim()) {
                          void run(async () => { await api.patch(`/api/comments/${c.id}`, { text: next }); await load() })
                        }
                      }}>{t('common.edit')}</button>
                      <button onClick={() =>
                        void run(async () => { await api.del(`/api/comments/${c.id}`); await load() })
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

          <div className="subhead">
            {t('task.watchers')} <span className="chip count">{task.watchers.length}</span>
          </div>
          <div className="val" style={{ gap: '0.4rem' }}>
            <AvatarStack users={task.watchers} size={24} max={8} />
            <span className="hint">{t('task.watchHint')}</span>
          </div>

          <div className="subhead">{t('task.activity')}</div>
          {task.activity.length === 0 && <div className="hint">{t('task.noActivity')}</div>}
          <ol className="activity">
            {task.activity.map(item => (
              <li key={item.id}>
                <span className="dot" aria-hidden />
                <span className="who">{item.actor?.name ?? t('task.deletedUser')}</span>
                <span className="what">{describeActivity(item)}</span>
                <span className="when">{fmt.timeAgo(item.createdAt)}</span>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </>
  )

  /** Renders an activity line in the interface language, statuses included. */
  function describeActivity(item: ActivityItem): string {
    const meta = item.meta ?? {}
    const asStatus = (v: unknown) =>
      typeof v === 'string' && ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'].includes(v)
        ? statusLabel(v as TaskStatus)
        : String(v ?? '')
    return t(`act.${item.kind}` as 'act.created', {
      from: asStatus(meta.from),
      to: asStatus(meta.to),
      userName: meta.userName ?? '',
      fileName: meta.fileName ?? '',
    })
  }
}

function LabelPicker({ labels, active, onToggle, onCreate }: {
  labels: { id: string; title: string; color: string }[]
  active: string[]
  onToggle: (id: string) => void
  onCreate: (title: string) => Promise<boolean>
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const filtered = labels.filter(l => l.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const exact = filtered.some(l => l.title.toLocaleLowerCase() === query.trim().toLocaleLowerCase())

  return (
    <Popover trigger={<button className="btn sm ghost">+ {t('task.label')}</button>}>
      {() => (
        <>
          <input className="input sm" style={{ marginBottom: '0.35rem' }} placeholder={t('task.labelSearch')}
            value={query} onChange={e => setQuery(e.target.value)} />
          {filtered.map(label => (
            <button key={label.id} className={`row${active.includes(label.id) ? ' on' : ''}`}
              onClick={() => onToggle(label.id)}>
              <span className="swatch" style={{ background: label.color, width: 10, height: 10, borderRadius: 3 }} />
              {label.title}
            </button>
          ))}
          {query.trim() && !exact && (
            <button className="row" onClick={() => void onCreate(query.trim()).then(ok => { if (ok) setQuery('') })}>
              + {t('task.createLabel', { title: query.trim() })}
            </button>
          )}
        </>
      )}
    </Popover>
  )
}
