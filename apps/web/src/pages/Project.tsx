import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../store'
import { useT } from '../i18n'
import { DotsIcon, Markdown, Popover, Star, TaskKey, useAction, useFormat, useToast, useUndoableAction } from '../ui'
import type { ProjectDetail, Task } from '../types'
import TaskRow from '../components/TaskRow'
import Kanban from '../components/Kanban'
import TableView from '../components/TableView'
import GanttView from '../components/GanttView'
import CalendarView from '../components/CalendarView'
import TaskPanel from '../components/TaskPanel'
import ShareDialog from '../components/ShareDialog'
import FilterBar, { applyFilters } from '../components/FilterBar'
import SavedViews from '../components/SavedViews'
import { useViewState, VIEWS } from '../views'
import { useCompletion } from '../completion'
import Documents from '../components/Documents'



export default function Project() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { labels, refreshProjects } = useApp()
  const t = useT()
  const run = useAction()
  const toast = useToast()
  const fmt = useFormat()
  const undoable = useUndoableAction()
  const completion = useCompletion()
  const [project, setProject] = useState<ProjectDetail | null>(null)
  // View and filters live in the URL, so a filtered board survives a reload
  // and the address bar is something you can paste to a colleague.
  const { state: { view, filters }, setView, setFilters, applyQuery } = useViewState()
  const [newTitle, setNewTitle] = useState('')
  const [sharing, setSharing] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState('')

  const openTaskId = params.get('task')

  const load = useCallback(async () => {
    if (!id) return
    setProject(await api.get<ProjectDetail>(`/api/projects/${id}`))
  }, [id])

  // Filters are no longer reset here: arriving on a link that carries them
  // has to keep them, and switching projects already changes the URL.
  useEffect(() => { void load() }, [load])

  const refresh = useCallback(async () => {
    await load()
    await refreshProjects()
  }, [load, refreshProjects])

  const members = useMemo(() => project
    ? [project.owner, ...project.members.map(m => m.user)].filter((u, i, arr) => arr.findIndex(x => x.id === u.id) === i)
    : [], [project])

  if (!project) return null
  const canEdit = project.role !== 'VIEWER'
  const isAdmin = project.role === 'ADMIN'

  const visibleTasks = applyFilters(project.tasks, filters)
  // A board cannot show an empty done column; completed work belongs there
  const boardTasks = applyFilters(project.tasks, { ...filters, done: '' })
  const topLevel = visibleTasks.filter(x => !x.parentId || !visibleTasks.some(p => p.id === x.parentId))
  const childrenOf = (taskId: string) => visibleTasks.filter(x => x.parentId === taskId)

  const openTask = (task: Task | string) =>
    setParams(p => { p.set('task', typeof task === 'string' ? task : task.id); return p }, { replace: true })
  const closeTask = () => setParams(p => { p.delete('task'); return p }, { replace: true })

  const toggle = (task: Task) => void completion.toggle(task, {
    optimistic: done => setProject(p => p && ({
      ...p, tasks: p.tasks.map(x => (x.id === task.id ? { ...x, done } : x)),
    })),
    reload: refresh,
  })
  /** Dragging to another day keeps the old date in the toast so it can be undone. */
  const reschedule = (task: Task, due: Date) => {
    const previous = task.dueDate
    void run(async () => {
      await api.patch(`/api/tasks/${task.id}`, { dueDate: due.toISOString() })
      await refresh()
      toast(t('calendar.rescheduled', { key: task.key, date: fmt.date(due) }), 'ok', {
        label: t('common.undo'),
        run: () => void run(async () => {
          await api.patch(`/api/tasks/${task.id}`, { dueDate: previous })
          await refresh()
        }),
      })
    })
  }

  // Deletion is immediate but undoable for eight seconds. No confirm dialog
  const removeTask = (task: Task) =>
    void undoable({
      run: () => api.del(`/api/tasks/${task.id}`),
      undo: () => api.post(`/api/trash/task/${task.id}/restore`),
      message: t('toast.taskDeleted'),
      onDone: () => void refresh(),
    })

  const addTask = () => {
    const value = newTitle.trim()
    if (!value) return
    setNewTitle('')
    void run(async () => { await api.post(`/api/projects/${project.id}/tasks`, { title: value }); await refresh() })
  }

  const saveDesc = () =>
    void run(async () => {
      await api.patch(`/api/projects/${project.id}`, { description: descDraft })
      setEditingDesc(false)
      await load()
    })

  const toggleFavorite = () =>
    void run(async () => {
      if (project.isFavorite) await api.del(`/api/favorites/project/${project.id}`)
      else await api.post('/api/favorites', { kind: 'project', targetId: project.id })
      await refresh()
    })

  const wide = view !== 'list'

  return (
    <div className={`content-inner${wide ? ' wide' : ''}`}>
      <div className="page-head">
        <h2>
          <span className="swatch" style={{ background: project.color }} />
          {project.title}
          <TaskKey value={project.key} />
          <Star on={project.isFavorite} onToggle={toggleFavorite} />
          {project.archived && <span className="chip count">{t('project.archived')}</span>}
        </h2>

        <div className="segmented">
          {VIEWS.map(v => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {v === 'docs' ? t('docs.title') : t(`project.view.${v}` as 'project.view.list')}
            </button>
          ))}
        </div>

        {isAdmin && <button className="btn" onClick={() => setSharing(true)}>{t('common.share')}</button>}
        {isAdmin && (
          <Popover align="right" trigger={<button className="icon-btn"><DotsIcon /></button>}>
            {close => (
              <>
                <button className="row" onClick={() => {
                  const value = window.prompt(t('nav.projectName'), project.title)
                  if (value?.trim()) {
                    void run(async () => { await api.patch(`/api/projects/${project.id}`, { title: value.trim() }); await refresh() })
                  }
                  close()
                }}>{t('common.rename')}</button>
                <button className="row" onClick={() => {
                  const value = window.prompt(t('project.changeColor'), project.color)
                  if (value && /^#[0-9a-fA-F]{6}$/.test(value)) {
                    void run(async () => { await api.patch(`/api/projects/${project.id}`, { color: value }); await refresh() })
                  }
                  close()
                }}>{t('project.changeColor')}</button>
                <button className="row" onClick={() => {
                  const value = window.prompt(t('project.keyHint', { key: project.key }), project.key)
                  if (value?.trim()) {
                    void run(async () => { await api.patch(`/api/projects/${project.id}`, { key: value.trim().toUpperCase() }); await refresh() })
                  }
                  close()
                }}>{t('project.changeKey')}</button>
                <button className="row" onClick={() => {
                  void run(async () => { await api.patch(`/api/projects/${project.id}`, { archived: !project.archived }); await refresh() })
                  close()
                }}>{project.archived ? t('project.unarchive') : t('project.archive')}</button>
                <button className="row" style={{ color: 'var(--danger)' }} onClick={() => {
                  if (window.confirm(t('project.deleteConfirm', { title: project.title }))) {
                    void undoable({
                      run: () => api.del(`/api/projects/${project.id}`),
                      undo: () => api.post(`/api/trash/project/${project.id}/restore`),
                      message: t('toast.projectDeleted'),
                      onDone: () => void refreshProjects(),
                    }).then(ok => { if (ok) navigate('/') })
                  }
                  close()
                }}>{t('project.delete')}</button>
              </>
            )}
          </Popover>
        )}
      </div>

      {editingDesc ? (
        <div className="card" style={{ padding: '1rem', marginBottom: '1rem' }}>
          <textarea className="input" rows={4} value={descDraft} onChange={e => setDescDraft(e.target.value)}
            placeholder={t('project.descPlaceholder')} autoFocus />
          <div className="desc-actions">
            <button className="btn primary sm" onClick={saveDesc}>{t('common.save')}</button>
            <button className="btn ghost sm" onClick={() => setEditingDesc(false)}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : project.description.trim() ? (
        <div className="card" style={{ padding: '0.9rem 1.1rem', marginBottom: '1rem', cursor: isAdmin ? 'pointer' : 'default' }}
          onClick={() => { if (isAdmin) { setDescDraft(project.description); setEditingDesc(true) } }}>
          <Markdown text={project.description} />
        </div>
      ) : isAdmin ? (
        <div className="desc-placeholder" style={{ marginBottom: '0.8rem' }}
          onClick={() => { setDescDraft(''); setEditingDesc(true) }}>
          + {t('project.addDescription')}
        </div>
      ) : null}

      {view !== 'docs' && (
        <div className="filterbar-row">
          <FilterBar filters={filters} onChange={setFilters} labels={labels} members={members} />
          <SavedViews
            projectId={project.id}
            state={{ view, filters }}
            onApply={applyQuery}
            canShare={canEdit}
          />
        </div>
      )}

      {view === 'list' && (
        <div className="card">
          {canEdit && (
            <div className="add-task">
              <input className="input" placeholder={t('project.newTask')} value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addTask() }} />
              <button className="btn primary" onClick={addTask}>{t('common.add')}</button>
            </div>
          )}
          <div className="task-list">
            {topLevel.length === 0 && <div className="empty">{t('project.noTasks')}</div>}
            {topLevel.map(task => (
              <div key={task.id}>
                <TaskRow task={task} leaving={completion.leaving.has(task.id)} onToggle={toggle} onOpen={openTask}
                  onDelete={canEdit ? removeTask : undefined} />
                {childrenOf(task.id).map(child => (
                  <TaskRow key={child.id} task={child} indent leaving={completion.leaving.has(child.id)}
                    onToggle={toggle} onOpen={openTask}
                    onDelete={canEdit ? removeTask : undefined} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {view === 'kanban' && <Kanban project={project} tasks={boardTasks} onChange={refresh} onOpen={openTask} />}
      {view === 'table' && <TableView tasks={visibleTasks} onOpen={openTask} onToggle={toggle} />}
      {view === 'calendar' && (
        <CalendarView
          tasks={boardTasks}
          onOpen={openTask}
          onToggle={toggle}
          onReschedule={canEdit ? reschedule : undefined}
        />
      )}
      {view === 'gantt' && <GanttView tasks={visibleTasks} onOpen={openTask} />}
      {view === 'docs' && <Documents project={project} onOpenTask={openTask} />}

      {openTaskId && (
        <TaskPanel
          taskId={openTaskId}
          project={project}
          onClose={closeTask}
          onChanged={() => void refresh()}
          onOpenTask={openTask}
        />
      )}
      {sharing && <ShareDialog project={project} onClose={() => setSharing(false)} onChanged={load} />}
    </div>
  )
}
