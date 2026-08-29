import { useState, type DragEvent } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { AvatarStack, DotsIcon, DueChip, LabelChip, Popover, PriorityChip, TypeIcon, useAction, useToast } from '../ui'
import type { ProjectDetail, Task } from '../types'

interface Props {
  project: ProjectDetail
  tasks: Task[]
  onChange: () => Promise<void>
  onOpen: (task: Task) => void
}

export default function Kanban({ project, tasks, onChange, onOpen }: Props) {
  const t = useT()
  const run = useAction()
  const toast = useToast()
  const canEdit = project.role !== 'VIEWER'
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [newCol, setNewCol] = useState(false)
  const [newColTitle, setNewColTitle] = useState('')

  const onDrop = async (e: DragEvent, bucketId: string) => {
    e.preventDefault()
    setDragOver(null)
    const taskId = e.dataTransfer.getData('text/task-id')
    if (!taskId) return

    // Dropping a card on its own column is not a move; leave it alone
    const task = tasks.find(x => x.id === taskId)
    if (!task || task.bucketId === bucketId) return

    const bucket = project.buckets.find(b => b.id === bucketId)
    const completes = !!bucket?.isDoneBucket && !task.done

    await run(async () => { await api.patch(`/api/tasks/${taskId}`, { bucketId }); await onChange() })

    // Dragging into the done column completes the task, so keep undo at hand
    if (completes) {
      toast(t('task.completedToast', { key: task.key }), 'ok', {
        label: t('common.undo'),
        run: () => void run(async () => {
          await api.patch(`/api/tasks/${taskId}`, { bucketId: task.bucketId, done: false })
          await onChange()
        }),
      })
    }
  }

  const addTask = async (bucketId: string) => {
    const value = title.trim()
    if (!value) return
    setTitle('')
    setAddingTo(null)
    await run(async () => { await api.post(`/api/projects/${project.id}/tasks`, { title: value, bucketId }); await onChange() })
  }

  const addColumn = async () => {
    const value = newColTitle.trim()
    if (!value) return
    setNewColTitle('')
    setNewCol(false)
    await run(async () => { await api.post(`/api/projects/${project.id}/buckets`, { title: value }); await onChange() })
  }

  const moveColumn = async (bucketId: string, dir: -1 | 1) => {
    const sorted = [...project.buckets].sort((a, b) => a.position - b.position)
    const index = sorted.findIndex(b => b.id === bucketId)
    const target = sorted[index + dir]
    if (!target) return
    await run(async () => {
      await api.patch(`/api/buckets/${bucketId}`, { position: target.position + (dir === -1 ? -1 : 1) })
      await onChange()
    })
  }

  return (
    <div className="kanban">
      {project.buckets.map(bucket => {
        const items = tasks.filter(task => task.bucketId === bucket.id)
        const overLimit = bucket.limit > 0 && items.filter(x => !x.done).length > bucket.limit
        return (
          <div
            key={bucket.id}
            className={`kb-col${dragOver === bucket.id ? ' drag-over' : ''}${overLimit ? ' over-limit' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(bucket.id) }}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => void onDrop(e, bucket.id)}
          >
            <div className="kb-head">
              {bucket.isDoneBucket && <span className="done-mark">✓</span>}
              {canEdit ? (
                <input
                  defaultValue={bucket.title}
                  aria-label={t('kanban.columnName')}
                  onBlur={e => {
                    const value = e.target.value.trim()
                    if (value && value !== bucket.title) {
                      void run(async () => { await api.patch(`/api/buckets/${bucket.id}`, { title: value }); await onChange() })
                    }
                  }}
                />
              ) : bucket.title}
              <span className="count">{items.length}{bucket.limit > 0 && ` / ${bucket.limit}`}</span>
              {canEdit && (
                <Popover align="right" trigger={<button className="icon-btn" style={{ width: 24, height: 24 }}><DotsIcon /></button>}>
                  {close => (
                    <>
                      <button className="row" onClick={() => { void moveColumn(bucket.id, -1); close() }}>← {t('kanban.moveLeft')}</button>
                      <button className="row" onClick={() => { void moveColumn(bucket.id, 1); close() }}>{t('kanban.moveRight')} →</button>
                      <button className="row" onClick={() => {
                        const value = window.prompt(t('kanban.wipPrompt'), String(bucket.limit))
                        if (value !== null) {
                          void run(async () => { await api.patch(`/api/buckets/${bucket.id}`, { limit: Number(value) || 0 }); await onChange() })
                        }
                        close()
                      }}>{t('kanban.wipLimit')}</button>
                      <button className="row" onClick={() => {
                        void run(async () => { await api.patch(`/api/buckets/${bucket.id}`, { isDoneBucket: !bucket.isDoneBucket }); await onChange() })
                        close()
                      }}>{bucket.isDoneBucket ? t('kanban.unmarkDone') : t('kanban.markDone')}</button>
                      <button className="row" style={{ color: 'var(--danger)' }} onClick={() => {
                        if (window.confirm(t('kanban.deleteColumnConfirm'))) {
                          void run(async () => { await api.del(`/api/buckets/${bucket.id}`); await onChange() })
                        }
                        close()
                      }}>{t('kanban.deleteColumn')}</button>
                    </>
                  )}
                </Popover>
              )}
            </div>

            <div className="kb-cards">
              {items.map(task => (
                <div
                  key={task.id}
                  className={`kb-card${task.done ? ' done' : ''}`}
                  style={{ borderLeftColor: task.color ?? 'var(--border)' }}
                  draggable={canEdit}
                  onDragStart={e => e.dataTransfer.setData('text/task-id', task.id)}
                  onClick={() => onOpen(task)}
                >
                  <div className="id">
                    <TypeIcon type={task.type} />
                    <span>#{task.number}</span>
                    <AvatarStack users={task.assignees} size={18} />
                  </div>
                  <div>{task.title}</div>
                  {(task.priority > 0 || task.dueDate || task.labels.length > 0 || task.subtaskCount > 0 || task.blockedBy > 0) && (
                    <div className="chips">
                      {task.blockedBy > 0 && !task.done && (
                        <span className="chip blocked" title={t('task.blockedBy', { count: task.blockedBy })}>
                          {t('task.blocked', { count: task.blockedBy })}
                        </span>
                      )}
                      {task.labels.slice(0, 3).map(l => <LabelChip key={l.id} label={l} />)}
                      <PriorityChip priority={task.priority} />
                      <DueChip dueDate={task.dueDate} done={task.done} />
                      {task.subtaskCount > 0 && (
                        <span className="chip count">{t('task.subtaskCount', { count: task.subtaskCount })}</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {canEdit && (addingTo === bucket.id ? (
              <input
                className="input sm" style={{ marginTop: '0.45rem' }} autoFocus
                placeholder={t('kanban.taskTitle')} value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void addTask(bucket.id)
                  if (e.key === 'Escape') { setAddingTo(null); setTitle('') }
                }}
                onBlur={() => { setAddingTo(null); setTitle('') }}
              />
            ) : (
              <button className="kb-add" onClick={() => setAddingTo(bucket.id)}>+ {t('kanban.addTask')}</button>
            ))}
          </div>
        )
      })}

      {canEdit && (
        <div className="kb-new-col">
          {newCol ? (
            <input
              className="input sm" autoFocus placeholder={t('kanban.columnName')} value={newColTitle}
              onChange={e => setNewColTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void addColumn()
                if (e.key === 'Escape') setNewCol(false)
              }}
              onBlur={() => setNewCol(false)}
            />
          ) : (
            <button className="btn ghost" onClick={() => setNewCol(true)}>+ {t('kanban.addColumn')}</button>
          )}
        </div>
      )}
    </div>
  )
}
