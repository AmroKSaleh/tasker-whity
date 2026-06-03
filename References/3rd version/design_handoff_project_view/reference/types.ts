// types.ts — placeholder shapes. Replace with the project's own types.

export type FilterId = 'all' | 'pending' | 'done' | 'rush' | 'high' | 'med' | 'low';

export type Priority = 'rush' | 'high' | 'med' | 'low' | null;
export type Status   = 'pending' | 'in_progress' | 'done';

export type Task = {
  id: string;
  sectionId: string;
  stageId: string | null;       // null = ungrouped
  title: string;
  status: Status;
  priority: Priority;
  due_at: string | null;        // ISO
  tags: string[];
  notes: string;
  position: number;
};

export type Stage = {
  id: string;
  sectionId: string;
  name: string;
  position: number;
  tasks: Task[];
};

export type Section = {
  id: string;
  projectId: string;
  name: string;
  position: number;
  collapsed: boolean;
  ungroupedTasks: Task[];       // tasks with stage_id === null
  stages: Stage[];
  doneCount: number;
  totalCount: number;
};

export type Project = {
  id: string;
  name: string;
  doneCount: number;
  totalCount: number;
};
