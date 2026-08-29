import type { Task } from '../types'
import { useT } from '../i18n'
import { AvatarStack, Checkbox, DueChip, LabelChip, PriorityChip, StatusPill, TaskKey, TrashIcon, TypeIcon } from '../ui'

interface Props {
  task: Task
  onToggle: (task: Task) => void
  onOpen: (task: Task) => void
  onDelete?: (task: Task) => void
  showProject?: boolean
  showStatus?: boolean
  indent?: boolean
  readOnly?: boolean
  /** Completed; about to slide out of the list. */
  leaving?: boolean
}

export default function TaskRow({ task, onToggle, onOpen, onDelete, showProject, showStatus, indent, readOnly, leaving }: Props) {
  const t = useT()
  return (
    <div className={`task-row${task.done ? ' done' : ''}${leaving ? ' leaving' : ''}`} onClick={() => onOpen(task)}>
      {indent && <span className="indent" />}
      <Checkbox on={task.done} onToggle={() => { if (!readOnly) onToggle(task) }} />
      <TypeIcon type={task.type} />
      <TaskKey value={task.key} />
      <span className="title">{task.title}</span>
      <span className="meta" onClick={e => e.stopPropagation()}>
        {showStatus && <StatusPill status={task.status} />}
        {task.blockedBy > 0 && !task.done && (
          <span className="chip blocked" title={t('task.blockedBy', { count: task.blockedBy })}>
            {t('task.blocked', { count: task.blockedBy })}
          </span>
        )}
        {task.labels.slice(0, 3).map(l => <LabelChip key={l.id} label={l} />)}
        <PriorityChip priority={task.priority} />
        <DueChip dueDate={task.dueDate} done={task.done} />
        {task.subtaskCount > 0 && <span className="chip count">{t('task.subtaskCount', { count: task.subtaskCount })}</span>}
        {task.commentCount > 0 && <span className="chip count">💬 {task.commentCount}</span>}
        {task.attachmentCount > 0 && <span className="chip count">📎 {task.attachmentCount}</span>}
        <AvatarStack users={task.assignees} size={22} />
        {showProject && task.project && <span className="chip count">{task.project.title}</span>}
      </span>
      {onDelete && (
        <button className="del" onClick={e => { e.stopPropagation(); onDelete(task) }} aria-label={t('common.delete')}>
          <TrashIcon />
        </button>
      )}
    </div>
  )
}
