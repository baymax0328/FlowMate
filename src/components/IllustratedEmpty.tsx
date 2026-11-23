import type { ReactNode } from 'react';
import trashArt from '../assets/empty-trash.svg';
import tasksArt from '../assets/empty-tasks.svg';
import documentsArt from '../assets/empty-documents.svg';

export function IllustratedEmpty({ title, kind, action }: { title: string; kind: 'tasks' | 'documents' | 'trash'; action?: ReactNode }) {
  return <div className={`illustrated-empty illustrated-empty-${kind}`}>
    <img src={kind === 'trash' ? trashArt : kind === 'tasks' ? tasksArt : documentsArt} alt="" aria-hidden="true" width="320" height="210" />
    <h3>{title}</h3>
    {action ? <div className="illustrated-empty-action">{action}</div> : null}
  </div>;
}
