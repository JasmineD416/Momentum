-- Team work can be assigned to more than one person.
-- Each work item's people are listed here. tasks.assignee_id is kept, holding the first person assigned,
-- so older copies of the app still read something sensible; task_assignees is the record that counts.

CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  position INTEGER NOT NULL DEFAULT 0,             -- order they were chosen in
  PRIMARY KEY (task_id, member_id)
);
CREATE INDEX task_assignees_member ON task_assignees(member_id);

-- Move every existing single assignee across, so no work item loses its person.
INSERT INTO task_assignees (task_id, member_id, position)
  SELECT id, assignee_id, 0 FROM tasks WHERE assignee_id IS NOT NULL;
