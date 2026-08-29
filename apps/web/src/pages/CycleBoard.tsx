import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useT } from '../i18n'
import { Avatar, AvatarStack, DotsIcon, DueChip, LabelChip, Modal, Popover, PriorityChip, StatusDot, TaskKey, TypeIcon, useAction, useFormat, useStatusLabel, useToast } from '../ui'
import { STATUS_ORDER, type CycleDetail, type Task, type TaskStatus } from '../types'
import TaskPanel from '../components/TaskPanel'
import { AssistBox, AssistButton, useAssist } from '../assist'
import { useApp } from '../store'

const DAY = 86400_000

export default function CycleBoard() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const t = useT()
  const fmt = useFormat()
  const statusLabel = useStatusLabel()
  const run = useAction()
  const toast = useToast()
  const { agent } = useApp()
  const update = useAssist<{ summary: string; points: string[] }>('/api/agent/summarize')
  const [cycle, setCycle] = useState<CycleDetail | null>(null)
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null)
  const [planning, setPlanning] = useState(false)
  const [candidates, setCandidates] = useState<Task[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const openTaskId = params.get('task')

  const load = useCallback(async () => {
    if (!id) return
    setCycle(await api.get<CycleDetail>(`/api/cycles/${id}`))
  }, [id])
  useEffect(() => { void load() }, [load])

  // Planning picks from open, uncycled tasks across the team's projects
  const openPlanning = async () => {
    setPlanning(true)
    setPicked(new Set())
    const all = await api.get<Task[]>('/api/tasks?done=false&take=200')
    setCandidates(all.filter(x => !x.cycleId))
  }

  const addPicked = async () => {
    if (!picked.size) return
    const ok = await run(
      () => api.post(`/api/cycles/${id}/tasks`, { taskIds: [...picked] }),
      t('cycle.added', { count: picked.size }),
    )
    if (ok) { setPlanning(false); await load() }
  }

  const onDrop = async (e: DragEvent, status: TaskStatus) => {
    e.preventDefault()
    setDragOver(null)
    const taskId = e.dataTransfer.getData('text/task-id')
    if (!taskId) return
    await run(async () => { await api.patch(`/api/tasks/${taskId}`, { status }); await load() })
  }

  if (!cycle) return null

  const daysLeft = Math.ceil((Date.parse(cycle.endsAt) - Date.now()) / DAY)
  const pct = cycle.summary.total ? Math.round((cycle.summary.done / cycle.summary.total) * 100) : 0
  const openTask = (taskId: string) => setParams(p => { p.set('task', taskId); return p }, { replace: true })

  return (
    <div className="content-inner wide">
      <div className="page-head">
        <h2>{cycle.name} <span className="chip count">{cycle.team.name}</span></h2>
        {agent.enabled && (
          <AssistButton
            label={t('assist.cycleUpdate')}
            busy={update.loading}
            onClick={() => void update.run({ kind: 'cycle', id: cycle.id })}
          />
        )}
        <button className="btn" onClick={openPlanning}>+ {t('cycle.addTasks')}</button>
        <Popover align="right" trigger={<button className="icon-btn"><DotsIcon /></button>}>
          {close => (
            <>
              <button className="row" onClick={() => {
                if (cycle.closedAt || window.confirm(t('cycle.closeConfirm'))) {
                  void run(async () => { await api.patch(`/api/cycles/${cycle.id}`, { closed: !cycle.closedAt }); await load() })
                }
                close()
              }}>{cycle.closedAt ? t('cycle.reopen') : t('cycle.close')}</button>
              <button className="row" style={{ color: 'var(--danger)' }} onClick={() => {
                if (window.confirm(t('cycle.deleteConfirm'))) {
                  void run(async () => { await api.del(`/api/cycles/${cycle.id}`); navigate('/cycles') })
                }
                close()
              }}>{t('cycle.delete')}</button>
            </>
          )}
        </Popover>
      </div>

      {(update.data || update.error) && (
        <AssistBox
          title={t('assist.cycleTitle')}
          error={update.error}
          onDismiss={update.reset}
          actions={update.data && (
            <button className="btn sm" onClick={() => {
              const text = [update.data!.summary, ...update.data!.points.map(x => `• ${x}`)].join('\n')
              void navigator.clipboard.writeText(text)
              toast(t('assist.copied'))
            }}>{t('assist.copy')}</button>
          )}
        >
          <p className="assist-summary">{update.data?.summary}</p>
          {update.data?.points.length ? (
            <ul className="assist-points">
              {update.data.points.map(point => <li key={point}>{point}</li>)}
            </ul>
          ) : null}
        </AssistBox>
      )}

      <div className="cycle-summary card">
        <div className="grow">
          {cycle.goal && <p className="goal">{cycle.goal}</p>}
          <div className="range">
            {fmt.date(cycle.startsAt)} – {fmt.date(cycle.endsAt)}
            {' · '}
            {cycle.closedAt ? t('cycle.closed') : daysLeft >= 0 ? t('cycle.daysLeft', { count: daysLeft }) : t('cycle.ended')}
          </div>
          <div className="progress" style={{ marginTop: '0.5rem' }}><div style={{ width: `${pct}%` }} /></div>
          <div className="range" style={{ marginTop: '0.3rem' }}>
            {t('cycle.progress', { done: cycle.summary.done, total: cycle.summary.total })}
            {cycle.summary.points > 0 && ` · ${t('cycle.points', { done: cycle.summary.donePoints, total: cycle.summary.points })}`}
          </div>
        </div>

        <div className="workload">
          <div className="workload-title">{t('cycle.workload')}</div>
          {cycle.workload.filter(w => w.total > 0).map(w => (
            <div key={w.user.id} className="workload-row">
              <Avatar user={w.user} size={22} />
              <span className="who">{w.user.name}</span>
              <span className="nums">
                {w.done}/{w.total}
                {w.inProgress > 0 && <span className="chip count">{statusLabel('IN_PROGRESS')} {w.inProgress}</span>}
              </span>
            </div>
          ))}
          {cycle.workload.every(w => w.total === 0) && <div className="hint">{t('cycle.noTasks')}</div>}
        </div>
      </div>

      <div className="kanban">
        {STATUS_ORDER.map(status => {
          const items = cycle.tasks.filter(task => task.status === status)
          const points = items.reduce((sum, x) => sum + (x.estimate ?? 0), 0)
          return (
            <div
              key={status}
              className={`kb-col${dragOver === status ? ' drag-over' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver(status) }}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => void onDrop(e, status)}
            >
              <div className="kb-head">
                <StatusDot status={status} />
                {statusLabel(status)}
                <span className="count">{items.length}{points > 0 && ` · ${points}p`}</span>
              </div>
              <div className="kb-cards">
                {items.map(task => (
                  <div key={task.id} className={`kb-card${task.done ? ' done' : ''}`}
                    style={{ borderLeftColor: task.project.color }}
                    draggable
                    onDragStart={e => e.dataTransfer.setData('text/task-id', task.id)}
                    onClick={() => openTask(task.id)}>
                    <div className="id">
                      <TypeIcon type={task.type} />
                      <TaskKey value={task.key} />
                      <AvatarStack users={task.assignees} size={18} />
                    </div>
                    <div>{task.title}</div>
                    <div className="chips">
                      {task.labels.slice(0, 2).map(l => <LabelChip key={l.id} label={l} />)}
                      <PriorityChip priority={task.priority} />
                      <DueChip dueDate={task.dueDate} done={task.done} />
                      {task.estimate != null && <span className="chip count">{t('task.points', { count: task.estimate })}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {planning && (
        <Modal title={t('cycle.planning')} onClose={() => setPlanning(false)} wide>
          <p className="hint" style={{ marginBottom: '0.6rem' }}>{t('cycle.candidates')}</p>
          <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
            {candidates.length === 0 && <div className="empty">{t('common.noResults')}</div>}
            {candidates.map(task => (
              <label key={task.id} className="pick-row">
                <input type="checkbox" checked={picked.has(task.id)} onChange={e => {
                  setPicked(prev => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(task.id); else next.delete(task.id)
                    return next
                  })
                }} />
                <TaskKey value={task.key} />
                <span className="grow">{task.title}</span>
                <PriorityChip priority={task.priority} />
                <span className="chip count">{task.project.title}</span>
              </label>
            ))}
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => setPlanning(false)}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={addPicked} disabled={!picked.size}>
              {t('cycle.addToCycle')} ({picked.size})
            </button>
          </div>
        </Modal>
      )}

      {openTaskId && (
        <TaskPanel
          taskId={openTaskId}
          project={null}
          onClose={() => setParams(p => { p.delete('task'); return p }, { replace: true })}
          onChanged={() => void load()}
          onOpenTask={openTask}
        />
      )}
    </div>
  )
}
