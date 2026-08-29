import type { TaskStatus, TaskType } from './types'

/** The markers the server highlights with; mirrors search.ts on the API side. */
const MARK_START = '\u0001'
const MARK_STOP = '\u0002'

export interface TaskHit {
  id: string
  key: string
  number: number
  title: string
  status: TaskStatus
  type: TaskType
  priority: number
  done: boolean
  dueDate: string | null
  projectId: string
  projectKey: string
  projectTitle: string
  snippet: string | null
}

export interface DocHit {
  id: string
  title: string
  projectId: string
  projectTitle: string
  snippet: string | null
}

export interface CommentHit {
  id: string
  taskId: string | null
  documentId: string | null
  taskKey: string | null
  createdAt: string
  authorName: string | null
  projectId: string
  parentTitle: string
  snippet: string | null
}

export interface SearchResults {
  query: string
  tasks: TaskHit[]
  documents: DocHit[]
  comments: CommentHit[]
}

export const hitCount = (r: SearchResults) =>
  r.tasks.length + r.documents.length + r.comments.length

export const isEmpty = (r: SearchResults | null) => !r || hitCount(r) === 0

/**
 * Renders a server snippet with its matches highlighted.
 *
 * The text is split on those markers and turned into React elements. It is
 * never rendered as HTML, so nothing a user typed can be interpreted as
 * markup.
 */
export function Snippet({ text }: { text: string | null }) {
  if (!text) return null
  const parts = text.split(MARK_START).flatMap((chunk, i) => {
    if (i === 0) return [{ hit: false, text: chunk }]
    const [hit, rest = ''] = chunk.split(MARK_STOP)
    return [{ hit: true, text: hit }, { hit: false, text: rest }]
  })
  return (
    <span className="snippet">
      {parts.map((part, i) => (
        part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>
      ))}
    </span>
  )
}
